import path from 'path';

import { DATA_DIR } from './config.js';

/**
 * Where a file a container named (/workspace/ipc/media/x.png) is on the host: inside that group's own IPC directory or nowhere. The path is
 * the container's to choose, and a picture sent to a student is now stored and served, so `..` must not lead out of it.
 */
export function ipcMediaPath(sourceGroup: string, containerPath: string, dataDir: string = DATA_DIR): string | null {
  const base = path.resolve(dataDir, 'ipc', sourceGroup);
  const hostPath = path.resolve(base, containerPath.replace(/^\/workspace\/ipc\//, ''));
  return hostPath.startsWith(base + path.sep) ? hostPath : null;
}
