import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  getAllChannels,
  getChannelById,
  getCountryVocabularies,
  saveCountryVocabulary,
  getExcludedCountries,
  addExcludedCountry,
  removeExcludedCountry,
  getQueueStatus,
  toggleQueuePause,
  getQuota,
  getSchemaInfo,
  performManualDatabaseBackup,
  getAllQueries,
  getQueriesByCountry,
  getRecentQueryExecutionLogs,
  getExtractedVocabulary,
  setQueryCollection,
  purgeSyntheticTestChannels
} from './server/db';
import {
  addSearchJob,
  addManualCountrySearch,
  addAutomatedCountrySearch,
  triggerManualRecheck,
  processNextSearchJob,
  executeFullManualSearch
} from './server/queueManager';
import { sanitizeSearchQuery } from './server/youtube';
import {
  runAutonomousDiscoveryCycle,
  getAutonomousDiscoveryStatus,
  startAutonomousDiscoveryScheduler,
  stopAutonomousDiscoveryScheduler,
  pauseQueryIntelligence,
  resumeQueryIntelligence,
  getDiscoveryScope,
  setDiscoveryScope
} from './server/autonomousDiscovery';
import { generateCandidateQueriesForCountry } from './server/queryIntelligence';
import {
  runRegressionTestSuite,
  getRegressionRuns,
  getLatestRegressionComparison
} from './server/regressionSuite';
import { runDatabaseStressTest } from './server/dbStressTest';
import { verifyChannelTradingRelevance, generateClassificationReport } from './server/evidenceEngine';
import { assertCountryAllowed, ExcludedCountryError } from './server/countryExclusion';
import { getManualSearchSession, listManualSearchSessions, requestManualSearchCancellation } from './server/manualSearchStore';


async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.use(express.json());

  const sendOperationError = (res: express.Response, err: any) => {
    if (err instanceof ExcludedCountryError) {
      return res.status(422).json({
        error: err.message,
        code: err.code,
        country: err.country,
        reason: err.reason
      });
    }
    return res.status(500).json({ error: err.message });
  };

  // Purge synthetic test records on startup
  try {
    await purgeSyntheticTestChannels();
  } catch (err) {
    console.warn('Startup purge failed:', err);
  }

  // --- API ROUTES ---

  // Health check
  app.get('/api/health', async (req, res) => {
    try {
      const schema = await getSchemaInfo();
      const queues = await getQueueStatus();
      res.json({ status: 'ok', database: 'ok', schemaVersion: schema.currentVersion, channelCount: schema.channelCount, queues });
    } catch (err: any) {
      res.status(503).json({ status: 'error', database: 'unavailable', error: err.message });
    }
  });

  // 1. Get all channels (returns active validated channels by default; include_rejected=true returns all)
  app.get('/api/channels', async (req, res) => {
    try {
      const includeRejected = req.query.include_rejected === 'true';
      const allChannels = await getAllChannels();
      if (includeRejected) {
        res.json(allChannels);
      } else {
        const activeChannels = allChannels.filter(c =>
          c.country_status !== 'REJECTED' &&
          c.scan_status !== 'SKIPPED_EXCLUDED' &&
          c.trading_status !== 'NON_TRADING'
        );
        res.json(activeChannels);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dedicated diagnostics view for rejected / excluded channels
  app.get('/api/channels/diagnostics/rejected', async (req, res) => {
    try {
      const allChannels = await getAllChannels();
      const rejectedChannels = allChannels.filter(c =>
        c.country_status === 'REJECTED' ||
        c.scan_status === 'SKIPPED_EXCLUDED' ||
        c.trading_status === 'NON_TRADING' ||
        c.discord_status === 'NON_TRADING'
      );
      res.json(rejectedChannels);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. Get single channel
  app.get('/api/channels/:id', async (req, res) => {
    try {
      const channel = await getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });

      res.json(channel);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2b. Permanent Classification Report for Stored Channel
  app.get('/api/channels/:id/report', async (req, res) => {
    try {
      const channel = await getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });

      await assertCountryAllowed(channel.country, 'stored_classification_report');

      const report = await generateClassificationReport({
        channel_id: channel.channel_id,
        channel_name: channel.channel_name,
        description: channel.inspection_trail?.find(t => t.step === 'BIO')?.details || '',
        video_titles: [],
        country: channel.country,
        location_tag: channel.country
      });

      res.json(report);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 2c. On-Demand Relevance Verification Endpoint
  app.post('/api/relevance/verify', async (req, res) => {
    try {
      const { channelName, channel_name, description, videoTitles, video_titles, country, locationTag, location_tag } = req.body;
      const cName = channelName || channel_name;
      if (!cName) return res.status(400).json({ error: 'Missing channel_name or channelName parameter.' });

      await assertCountryAllowed(country || 'United States', 'relevance_verification');

      const decision = await verifyChannelTradingRelevance({
        channel_name: cName,
        description: description || '',
        video_titles: videoTitles || video_titles || [],
        country: country || 'United States',
        location_tag: locationTag || location_tag
      });

      res.json(decision);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 2d. Permanent Classification Report Generator Endpoint
  app.post('/api/relevance/report', async (req, res) => {
    try {
      const { channelName, channel_name, description, videoTitles, video_titles, country, locationTag, location_tag } = req.body;
      const cName = channelName || channel_name;
      if (!cName) return res.status(400).json({ error: 'Missing channel_name or channelName parameter.' });

      await assertCountryAllowed(country || 'United States', 'classification_report');

      const report = await generateClassificationReport({
        channel_name: cName,
        description: description || '',
        video_titles: videoTitles || video_titles || [],
        country: country || 'United States',
        location_tag: locationTag || location_tag
      });

      res.json(report);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 3. Execute manual search with full pipeline execution & stage tracing
  app.post('/api/search/manual', async (req, res) => {
    try {
      const { query, country } = req.body;
      if (!query || !country) {
        return res.status(400).json({ error: 'Missing required query or country parameter.' });
      }

      // Sanitize query to strictly remove any forbidden 'discord' keywords
      const sanitized = sanitizeSearchQuery(query);
      if (!sanitized) {
        return res.status(400).json({ error: 'Invalid search query. Query contained disallowed keywords.' });
      }

      console.log(`[Manual Search Requested] Query: "${sanitized}", Country: "${country}"`);

      const executionResult = await executeFullManualSearch(sanitized, country);

      res.json({
        message: `Manual search completed for '${sanitized}' (${country}).`,
        sanitizedQuery: sanitized,
        ...executionResult
      });
    } catch (err: any) {
      console.error('[Manual Search Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/search/manual/sessions', async (req, res) => {
    try { res.json(await listManualSearchSessions(Number(req.query.limit || 20))); }
    catch (err: any) { sendOperationError(res, err); }
  });

  app.get('/api/search/manual/sessions/:id', async (req, res) => {
    try { const session = await getManualSearchSession(req.params.id); if (!session) return res.status(404).json({ error: 'Manual search session not found.' }); res.json(session); }
    catch (err: any) { sendOperationError(res, err); }
  });

  app.post('/api/search/manual/sessions/:id/cancel', async (req, res) => {
    try { const session = await requestManualSearchCancellation(req.params.id); if (!session) return res.status(404).json({ error: 'Manual search session not found.' }); res.status(202).json(session); }
    catch (err: any) { sendOperationError(res, err); }
  });

  // 4. Generate & Run Automated Country Search
  app.post('/api/search/automated', async (req, res) => {
    try {
      const { country } = req.body;
      if (!country) {
        return res.status(400).json({ error: 'Missing country parameter.' });
      }

      const queries = await addAutomatedCountrySearch(country);
      
      // Kick off processing
      processNextSearchJob().catch(() => {});

      res.json({ message: `Generated ${queries.length} native queries for ${country}. Jobs queued.`, queries });
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 5. Trigger manual re-check
  app.post('/api/channels/:id/recheck', async (req, res) => {
    try {
      const result = await triggerManualRecheck(req.params.id, req.query.debug === 'true');
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. Get country vocabularies
  app.get('/api/country-vocabularies', async (req, res) => {
    try {
      const vocabs = await getCountryVocabularies();
      res.json(vocabs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. Save or update country vocabulary
  app.post('/api/country-vocabularies', async (req, res) => {
    try {
      await saveCountryVocabulary(req.body);
      res.json({ message: 'Country vocabulary saved.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 8. Get excluded countries
  app.get('/api/excluded-countries', async (req, res) => {
    try {
      const list = await getExcludedCountries();
      res.json(list);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 9. Add excluded country
  app.post('/api/excluded-countries', async (req, res) => {
    try {
      await addExcludedCountry(req.body);
      res.json({ message: 'Excluded country added.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 10. Remove excluded country
  app.delete('/api/excluded-countries/:name', async (req, res) => {
    try {
      await removeExcludedCountry(req.params.name);
      res.json({ message: 'Excluded country removed.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 11. Queue Status & Quota Info
  app.get('/api/queues/status', async (req, res) => {
    try {
      const queues = await getQueueStatus();
      const quota = await getQuota();
      res.json({ queues, quota });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 12. Toggle Queue Pause/Resume
  app.post('/api/queues/pause', async (req, res) => {
    try {
      const { queueName, isPaused } = req.body;
      await toggleQueuePause(queueName, isPaused);
      res.json({ message: `Queue '${queueName}' pause state updated to ${isPaused}.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 13. Database Schema Migrations & Versioning Info
  app.get('/api/database/schema-info', async (req, res) => {
    try {
      const info = await getSchemaInfo();
      res.json(info);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 14. Manual Database Backup Snapshot Trigger
  app.post('/api/database/backup', async (req, res) => {
    try {
      const backupResult = await performManualDatabaseBackup();
      res.json(backupResult);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- QUERY INTELLIGENCE ENGINE ROUTES ---

  // 15. Get Query Library
  app.get('/api/query-intelligence/library', async (req, res) => {
    try {
      const country = req.query.country as string | undefined;
      let queries = country ? await getQueriesByCountry(country) : await getAllQueries();
      res.json(queries);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 16. Get Extracted Vocabulary
  app.get('/api/query-intelligence/vocabulary', async (req, res) => {
    try {
      const country = req.query.country as string | undefined;
      const terms = await getExtractedVocabulary(country);
      res.json(terms);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 17. Get Execution Logs
  app.get('/api/query-intelligence/logs', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const logs = await getRecentQueryExecutionLogs(limit);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18. Get Autonomous Scheduler Status
  app.get('/api/query-intelligence/status', async (req, res) => {
    try {
      const status = await getAutonomousDiscoveryStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18b. Pause Query Intelligence Engine
  app.post('/api/query-intelligence/pause', async (req, res) => {
    try {
      const result = await pauseQueryIntelligence();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18c. Resume Query Intelligence Engine
  app.post('/api/query-intelligence/resume', async (req, res) => {
    try {
      const result = await resumeQueryIntelligence();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18d. Get Discovery Scope Configuration
  app.get('/api/query-intelligence/scope', async (req, res) => {
    try {
      const scope = await getDiscoveryScope();
      res.json(scope);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18e. Update Discovery Scope Configuration
  app.post('/api/query-intelligence/scope', async (req, res) => {
    try {
      const { scope, selectedCountries } = req.body;
      if (!scope || !['GLOBAL', 'SELECTED_COUNTRIES'].includes(scope)) {
        return res.status(400).json({ error: 'Invalid scope mode. Must be GLOBAL or SELECTED_COUNTRIES.' });
      }
      const updated = await setDiscoveryScope(scope, selectedCountries || []);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 19. Run Autonomous Discovery Cycle On-Demand
  app.post('/api/query-intelligence/run-cycle', async (req, res) => {
    try {
      const { country } = req.body;
      const result = await runAutonomousDiscoveryCycle(country);
      res.json(result);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 20. Generate Candidate Queries
  app.post('/api/query-intelligence/generate-candidates', async (req, res) => {
    try {
      const { country, count } = req.body;
      if (!country) return res.status(400).json({ error: 'Missing required country parameter.' });
      const generated = await generateCandidateQueriesForCountry(country, count || 3);
      res.json(generated);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 21. Update Query Collection (Promote / Demote)
  app.post('/api/query-intelligence/queries/:id/collection', async (req, res) => {
    try {
      const queryId = parseInt(req.params.id);
      const { collection } = req.body;
      if (!['PROVEN', 'EXPERIMENTAL', 'REJECTED'].includes(collection)) {
        return res.status(400).json({ error: 'Invalid collection type. Must be PROVEN, EXPERIMENTAL, or REJECTED.' });
      }
      await setQueryCollection(queryId, collection);
      res.json({ message: `Query #${queryId} moved to collection '${collection}'.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- AUTOMATED REGRESSION SUITE ROUTES ---

  // 22. Get Historical Regression Runs
  app.get('/api/regression/runs', async (req, res) => {
    try {
      const runs = await getRegressionRuns();
      res.json(runs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 23. Get Latest Regression Diff Comparison Report vs Baseline
  app.get('/api/regression/latest', async (req, res) => {
    try {
      const comparison = await getLatestRegressionComparison();
      res.json(comparison);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 24. Trigger Automated Execution of the Regression Test Suite
  app.post('/api/regression/run', async (req, res) => {
    try {
      const { runLabel } = req.body;
      const runRecord = await runRegressionTestSuite(runLabel);
      res.json(runRecord);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 25. Database Concurrency & Persistence Stress Test Endpoint
  app.post('/api/db/stress-test', async (req, res) => {
    try {
      const testResult = await runDatabaseStressTest();
      res.json(testResult);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 26. Clean Synthetic Stress Test Records Endpoint
  app.post('/api/db/clean-stress-tests', async (req, res) => {
    try {
      const purgedCount = await purgeSyntheticTestChannels();
      res.json({ success: true, purgedCount, message: `Purged ${purgedCount} synthetic stress test channels.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- VITE / STATIC SERVING ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Trading Community Discovery Engine running on http://0.0.0.0:${PORT}`);
    startAutonomousDiscoveryScheduler();
  });
}

startServer().catch(err => {
  console.error('Fatal error starting server:', err);
});
