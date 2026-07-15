import { dirname, join } from 'node:path'

const path = process.argv[2]
if (!path) throw new Error('Database path is required')

process.env.XDG_CONFIG_HOME = join(dirname(path), `worker-${process.pid}`)
const { createDatabase } = await import('../plugin/storage/sqlite.js')
createDatabase(path).close()
