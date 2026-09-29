const path = require('node:path');
const os = require('node:os');
const { createRoom } = require('../server/room.cjs');

const room = createRoom({
  host: '127.0.0.1', port: 4827, key: 'preview-only',
  dataDir: path.join(os.tmpdir(), 'hello-pet-preview'),
  staticDir: path.join(__dirname, '..', 'public')
});
room.listen().then(() => console.log('Preview: http://127.0.0.1:4827/?preview=1'));
process.on('SIGINT', async () => { await room.close(); process.exit(0); });
