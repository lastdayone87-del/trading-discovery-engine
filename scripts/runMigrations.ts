import dotenv from 'dotenv';
dotenv.config();
import { runMigrations } from '../server/db';

runMigrations()
  .then(migrations => {
    console.log('[PostgreSQL Migrations] Applied/current migrations:');
    for (const m of migrations) console.log(`- ${m.version}: ${m.name} (${m.applied_at})`);
  })
  .catch(err => {
    console.error('[PostgreSQL Migrations] Failed:', err);
    process.exit(1);
  });
