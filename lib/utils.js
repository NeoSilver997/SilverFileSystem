/**
 * Utility functions for formatting and display
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: join(__dirname, '..', '.env') });

/**
 * Load configuration from config.json file and environment variables
 * Environment variables take precedence over config.json values
 */
export function loadConfig() {
  let fileConfig = {};
  
  // Try to load config.json
  try {
    const configPath = join(__dirname, '..', 'config.json');
    const configData = readFileSync(configPath, 'utf8');
    fileConfig = JSON.parse(configData);
  } catch (err) {
    console.warn(`Warning: Could not load config.json (${err.message}). Using defaults and environment variables.`);
  }

  // Merge file config with environment variables (env vars take precedence)
  const config = {
    scanner: {
      followSymlinks: fileConfig.scanner?.followSymlinks || false,
      maxDepth: fileConfig.scanner?.maxDepth || 100,
      excludePatterns: fileConfig.scanner?.excludePatterns || ['node_modules', '.git', '.cache', 'temp', 'tmp']
    },
    duplicates: {
      minSize: fileConfig.duplicates?.minSize || 0,
      useQuickHash: fileConfig.duplicates?.useQuickHash || true
    },
    largeFiles: {
      minSizeMB: fileConfig.largeFiles?.minSizeMB || 100,
      limit: fileConfig.largeFiles?.limit || 50
    },
    database: {
      host: process.env.DB_HOST || fileConfig.database?.host || 'localhost',
      port: parseInt(process.env.DB_PORT || fileConfig.database?.port || '3306'),
      user: process.env.DB_USER || fileConfig.database?.user || 'root',
      password: process.env.DB_PASSWORD || fileConfig.database?.password || '',
      database: process.env.DB_NAME || fileConfig.database?.database || 'silverfilesystem'
    }
  };

  return config;
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
