import dotenv from 'dotenv';
dotenv.config();
import { runMigrations } from '../server/db';

runMigrations()
  .then(migrations => {
    console.log('[PostgreSQL Migrations] Applied/current migrations:');
    for (const m of migrations) console.log(`- ${m.version}: ${m.name} (${m.applied_at})`);
    // The standalone migration command must terminate before Railway runs the app start command.
    // Some imported database/provider modules can leave handles open after the pool closes.
    process.exit(0);
  })
  .catch(err => {
    console.error('[PostgreSQL Migrations] Failed:', err);
    process.exit(1);
  });
