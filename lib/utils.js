/**
 * Utility functions for formatting and display
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load configuration from config.json file
 */
export function loadConfig() {
  try {
    const configPath = join(__dirname, '..', 'config.json');
    const configData = readFileSync(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (err) {
    console.warn(`Warning: Could not load config.json (${err.message}). Using defaults.`);
    return {
      scanner: {
        followSymlinks: false,
        maxDepth: 100,
        excludePatterns: ['node_modules', '.git', '.cache', 'temp', 'tmp']
      },
      duplicates: {
        minSize: 0,
        useQuickHash: true
      },
      largeFiles: {
        minSizeMB: 100,
        limit: 50
      },
      database: {
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: '',
        database: 'silverfilesystem'
      }
    };
  }
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Format date to readable string
 */
export function formatDate(date) {
  return new Date(date).toLocaleString();
}

/**
 * Truncate path for display
 */
export function truncatePath(filePath, maxLength = 80) {
  if (filePath.length <= maxLength) {
    return filePath;
  }
  
  const start = filePath.substring(0, maxLength / 2 - 2);
  const end = filePath.substring(filePath.length - maxLength / 2 + 2);
  return `${start}...${end}`;
}

/**
 * Get file statistics summary
 */
export function getFileStats(files) {
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const avgSize = files.length > 0 ? totalSize / files.length : 0;
  
  return {
    count: files.length,
    totalSize,
    avgSize,
    minSize: files.length > 0 ? Math.min(...files.map(f => f.size)) : 0,
    maxSize: files.length > 0 ? Math.max(...files.map(f => f.size)) : 0
  };
}
