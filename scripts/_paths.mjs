// 共享路径解析：让所有脚本在「仓库内」和「宿主数据目录」两种布局下都能跑。
// 优先级：ATLAS_DIR 环境变量 > 仓库根（若含 catalog.json）> ~/.dsh/tool-atlas
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ATLAS_DIR =
  process.env.ATLAS_DIR ||
  (existsSync(path.join(ROOT, 'catalog.json')) ? ROOT : path.join(os.homedir(), '.dsh', 'tool-atlas'));

export const SERVER = path.join(ATLAS_DIR, 'server.mjs');
export const CATALOG = path.join(ATLAS_DIR, 'catalog.json');
export const VECTORS = path.join(ATLAS_DIR, 'vectors.json');
export const STATE = path.join(ATLAS_DIR, 'discover-state.json');
