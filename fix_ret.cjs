const fs = require('fs');
let code = fs.readFileSync('server/queueManager.ts', 'utf-8');

code = code.replace(
  '    } else {\n      channel.scan_status = \'FAILED\';\n    }\n  } finally {\n    await upsertChannel(channel);\n  }\n}',
  '    } else {\n      channel.scan_status = \'FAILED\';\n    }\n  } finally {\n    await upsertChannel(channel);\n  }\n}'
);
// I'll just declare let inspectionRes = null; inside the function.
