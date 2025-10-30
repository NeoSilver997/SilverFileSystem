#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { FileScanner } from '../lib/scanner.js';
import { DuplicateFinder } from '../lib/duplicates.js';
import { EmptyFinder } from '../lib/empty.js';
import { LargeFilesFinder } from '../lib/large.js';
import { BrokenFilesFinder } from '../lib/broken.js';
import { DatabaseManager } from '../lib/database.js';
import { MediaMetadataExtractor } from '../lib/media.js';
import { formatBytes, truncatePath, loadConfig } from '../lib/utils.js';

const program = new Command();

// Get current file paths for worker
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load configuration
const config = loadConfig();

// Global database manager instance
let dbManager = null;

// Helper function to initialize database if --db flag is set
async function initDatabase(options) {
  if (options.db) {
    // Use config file values as defaults, allow CLI options to override
    const dbConfig = {
      host: options.dbHost || config.database.host,
      port: parseInt(options.dbPort || config.database.port),
      user: options.dbUser || config.database.user,
      password: options.dbPassword || config.database.password,
      database: options.dbName || config.database.database
    };
    
    console.log(chalk.gray(`Connecting to database: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`));
    
    dbManager = new DatabaseManager(dbConfig);
    await dbManager.connect();
    await dbManager.initializeTables();
    await dbManager.updateSchema();
  }
  return dbManager;
}

// Helper function to close database connection
async function closeDatabase() {
  if (dbManager) {
    await dbManager.close();
    dbManager = null;
  }
}

program
  .name('silverfs')
  .description('SilverFileSystem - Node.js file management tool for finding duplicates, empty files, and more')
  .version('1.0.0');

// Duplicate files command
program
  .command('duplicates')
  .description('Find duplicate files')
  .argument('<paths...>', 'Directories to scan')
  .option('-m, --min-size <bytes>', `Minimum file size to check (in bytes) (default: ${config.duplicates.minSize})`)
  .option('-q, --quick', `Use quick hash (faster but less accurate) (default: ${config.duplicates.useQuickHash})`)
  .option('--db', 'Store results in MySQL database')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (paths, options) => {
    const spinner = ora('Scanning for duplicate files...').start();
    
    try {
      // Initialize database if requested
      const db = await initDatabase(options);
      
      const scanner = new FileScanner();
      const finder = new DuplicateFinder(scanner);
      
      const minSize = parseInt(options.minSize || config.duplicates.minSize);
      const useQuickHash = options.quick !== undefined ? !options.quick : !config.duplicates.useQuickHash;
      
      const duplicates = await finder.findDuplicates(paths, { minSize, useQuickHash });
      const wastedSpace = finder.calculateWastedSpace(duplicates);
      
      // Store duplicates in database if enabled
      if (db && duplicates.length > 0) {
        spinner.text = 'Storing duplicate groups to database...';
        for (const group of duplicates) {
          if (group.length > 0 && group[0].hash) {
            await db.storeDuplicateGroup(group[0].hash, group.length, group[0].size);
          }
        }
      }
      
      spinner.succeed('Scan complete!');
      
      if (duplicates.length === 0) {
        console.log(chalk.green('\nNo duplicate files found!'));
        await closeDatabase();
        return;
      }
      
      console.log(chalk.yellow(`\nFound ${duplicates.length} groups of duplicate files:`));
      console.log(chalk.gray(`Wasted space: ${formatBytes(wastedSpace)}\n`));
      
      if (db) {
        console.log(chalk.green(`Database: Stored ${duplicates.length} duplicate groups\n`));
      }
      
      duplicates.forEach((group, index) => {
        console.log(chalk.cyan(`\nGroup ${index + 1} (${group.length} files, ${formatBytes(group[0].size)} each):`));
        group.forEach(file => {
          console.log(chalk.white(`  ${truncatePath(file.path)}`));
        });
      });
      
      await closeDatabase();
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
      process.exit(1);
    }
  });

// Empty files command
program
  .command('empty-files')
  .description('Find empty files (0 bytes)')
  .argument('<paths...>', 'Directories to scan')
  .action(async (paths) => {
    const spinner = ora('Scanning for empty files...').start();
    
    try {
      const finder = new EmptyFinder();
      const allEmptyFiles = [];
      
      for (const dirPath of paths) {
        const emptyFiles = await finder.findEmptyFiles(dirPath);
        allEmptyFiles.push(...emptyFiles);
      }
      
      spinner.succeed('Scan complete!');
      
      if (allEmptyFiles.length === 0) {
        console.log(chalk.green('\nNo empty files found!'));
        return;
      }
      
      console.log(chalk.yellow(`\nFound ${allEmptyFiles.length} empty files:\n`));
      allEmptyFiles.forEach(file => {
        console.log(chalk.white(`  ${truncatePath(file.path)}`));
      });
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Empty directories command
program
  .command('empty-dirs')
  .description('Find empty directories')
  .argument('<paths...>', 'Directories to scan')
  .action(async (paths) => {
    const spinner = ora('Scanning for empty directories...').start();
    
    try {
      const finder = new EmptyFinder();
      const allEmptyDirs = [];
      
      for (const dirPath of paths) {
        const emptyDirs = await finder.findEmptyDirectories(dirPath);
        allEmptyDirs.push(...emptyDirs);
      }
      
      spinner.succeed('Scan complete!');
      
      if (allEmptyDirs.length === 0) {
        console.log(chalk.green('\nNo empty directories found!'));
        return;
      }
      
      console.log(chalk.yellow(`\nFound ${allEmptyDirs.length} empty directories:\n`));
      allEmptyDirs.forEach(dir => {
        console.log(chalk.white(`  ${truncatePath(dir.path)}`));
      });
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Large files command
program
  .command('large-files')
  .description('Find large files')
  .argument('<paths...>', 'Directories to scan')
  .option('-m, --min-size <bytes>', `Minimum file size in MB (default: ${config.largeFiles.minSizeMB})`)
  .option('-l, --limit <number>', `Maximum number of results (default: ${config.largeFiles.limit})`)
  .action(async (paths, options) => {
    const spinner = ora('Scanning for large files...').start();
    
    try {
      const scanner = new FileScanner();
      const finder = new LargeFilesFinder(scanner);
      
      const minSize = parseInt(options.minSize || config.largeFiles.minSizeMB) * 1024 * 1024; // Convert MB to bytes
      const limit = parseInt(options.limit || config.largeFiles.limit);
      
      const largeFiles = await finder.findLargeFiles(paths, { minSize, limit });
      
      spinner.succeed('Scan complete!');
      
      if (largeFiles.length === 0) {
        console.log(chalk.green(`\nNo files larger than ${options.minSize} MB found!`));
        return;
      }
      
      console.log(chalk.yellow(`\nFound ${largeFiles.length} large files:\n`));
      largeFiles.forEach((file, index) => {
        console.log(chalk.cyan(`${index + 1}. ${formatBytes(file.size)}`));
        console.log(chalk.white(`   ${truncatePath(file.path)}`));
      });
      
      const totalSize = finder.calculateTotalSize(largeFiles);
      console.log(chalk.gray(`\nTotal size: ${formatBytes(totalSize)}`));
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Broken symlinks command
program
  .command('broken-symlinks')
  .description('Find broken symbolic links')
  .argument('<paths...>', 'Directories to scan')
  .action(async (paths) => {
    const spinner = ora('Scanning for broken symbolic links...').start();
    
    try {
      const finder = new BrokenFilesFinder();
      const allBrokenLinks = [];
      
      for (const dirPath of paths) {
        const brokenLinks = await finder.findBrokenSymlinks(dirPath);
        allBrokenLinks.push(...brokenLinks);
      }
      
      spinner.succeed('Scan complete!');
      
      if (allBrokenLinks.length === 0) {
        console.log(chalk.green('\nNo broken symbolic links found!'));
        return;
      }
      
      console.log(chalk.yellow(`\nFound ${allBrokenLinks.length} broken symbolic links:\n`));
      allBrokenLinks.forEach(link => {
        console.log(chalk.red(`  ${truncatePath(link.path)}`));
        console.log(chalk.gray(`    → ${link.target} (target not found)`));
      });
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Invalid names command
program
  .command('invalid-names')
  .description('Find files with invalid or problematic names')
  .argument('<paths...>', 'Directories to scan')
  .action(async (paths) => {
    const spinner = ora('Scanning for files with invalid names...').start();
    
    try {
      const finder = new BrokenFilesFinder();
      const allInvalidFiles = [];
      
      for (const dirPath of paths) {
        const invalidFiles = await finder.findInvalidNames(dirPath);
        allInvalidFiles.push(...invalidFiles);
      }
      
      spinner.succeed('Scan complete!');
      
      if (allInvalidFiles.length === 0) {
        console.log(chalk.green('\nNo files with invalid names found!'));
        return;
      }
      
      console.log(chalk.yellow(`\nFound ${allInvalidFiles.length} files with invalid names:\n`));
      allInvalidFiles.forEach(file => {
        console.log(chalk.red(`  ${truncatePath(file.path)}`));
        console.log(chalk.gray(`    Issue: ${file.issue}`));
      });
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Scan command (overview)
program
  .command('scan')
  .description('Quick overview scan of directory')
  .argument('<path>', 'Directory to scan')
  .option('--db', 'Store results in MySQL database')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (dirPath, options) => {
    const spinner = ora('Scanning directory...').start();
    let scanId = null;
    let mediaExtractor = null;
    
    try {
      // Initialize database if requested
      const db = await initDatabase(options);
      
      // Initialize media extractor if requested
      if (options.extractMedia) {
        mediaExtractor = new MediaMetadataExtractor();
      }
      
      if (db) {
        scanId = await db.createScanSession(dirPath);
        spinner.text = 'Scanning directory and storing to database...';
      }
      
      const scanner = new FileScanner();
      
      // Progress callback for detailed logging
      const progressCallback = (progress) => {
        switch (progress.type) {
          case 'progress':
            spinner.text = `Scanning... ${progress.processedFiles} files, ${progress.processedDirs} dirs (queue: ${progress.queueSize})`;
            break;
          case 'warning':
            console.warn(chalk.yellow(`\nWarning: ${progress.message}`));
            break;
          case 'complete':
            spinner.text = `Scan complete: ${progress.totalFiles} files from ${progress.processedDirs} directories`;
            break;
        }
      };

      const files = await scanner.scanDirectory(dirPath, progressCallback);
      
      // Store files in database if enabled
      if (db && files.length > 0) {
        spinner.text = 'Storing files to database...';
        const batchSize = 100;
        let storedCount = 0;
        
        for (let i = 0; i < files.length; i += batchSize) {
          const batch = files.slice(i, i + batchSize);
          await db.storeFilesBatch(batch, scanId);
          storedCount += batch.length;
          spinner.text = `Storing files to database... ${storedCount}/${files.length}`;
        }
        
        // Extract and store media metadata if requested
        if (options.extractMedia && mediaExtractor) {
          spinner.text = 'Extracting media metadata...';
          let mediaCount = 0;
          
          for (const file of files) {
            const result = await mediaExtractor.extractMetadata(file.path);
            if (result) {
              mediaCount++;
              spinner.text = `Extracting media metadata... (${mediaCount} files processed)`;
              
              // Get file ID from database
              const [rows] = await db.connection.execute(
                'SELECT id FROM scanned_files WHERE path = ? AND scan_id = ?',
                [file.path, scanId]
              );
              
              if (rows.length > 0) {
                const fileId = rows[0].id;
                
                if (result.type === 'photo') {
                  await db.storePhotoMetadata(fileId, result.metadata);
                } else if (result.type === 'music') {
                  await db.storeMusicMetadata(fileId, result.metadata);
                } else if (result.type === 'video') {
                  await db.storeVideoMetadata(fileId, result.metadata);
                }
              }
            }
          }
          
          if (mediaCount > 0) {
            console.log(chalk.green(`\nExtracted metadata for ${mediaCount} media files`));
          }
        }
        
        const totalSize = files.reduce((sum, file) => sum + file.size, 0);
        await db.completeScanSession(scanId, files.length, totalSize);
      }
      
      spinner.succeed('Scan complete!');
      
      // Calculate statistics
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      const emptyFiles = files.filter(f => f.size === 0);
      
      // Group by extension
      const extensions = new Map();
      files.forEach(file => {
        const ext = file.name.match(/\.([^.]+)$/)?.[1] || 'no extension';
        if (!extensions.has(ext)) {
          extensions.set(ext, { count: 0, size: 0 });
        }
        const stats = extensions.get(ext);
        stats.count++;
        stats.size += file.size;
      });
      
      console.log(chalk.yellow('\n=== Directory Overview ===\n'));
      console.log(chalk.white(`Path: ${dirPath}`));
      console.log(chalk.white(`Total files: ${files.length}`));
      console.log(chalk.white(`Total size: ${formatBytes(totalSize)}`));
      console.log(chalk.white(`Empty files: ${emptyFiles.length}`));
      
      if (db) {
        console.log(chalk.green(`Database: Stored in scan session #${scanId}`));
      }
      
      if (extensions.size > 0) {
        console.log(chalk.yellow('\n=== Top File Types ===\n'));
        const sorted = Array.from(extensions.entries())
          .sort((a, b) => b[1].size - a[1].size)
          .slice(0, 10);
        
        sorted.forEach(([ext, stats]) => {
          console.log(chalk.cyan(`  ${ext}: ${stats.count} files (${formatBytes(stats.size)})`));
        });
      }
      
      await closeDatabase();
      if (mediaExtractor) {
        await mediaExtractor.cleanup();
      }
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
      if (mediaExtractor) {
        await mediaExtractor.cleanup();
      }
      process.exit(1);
    }
  });

// Extract media metadata from database records
program
  .command('extract-media-from-db')
  .description('Extract media metadata from files already in database')
  .option('--db-host <host>', 'Database host', config.database.host)
  .option('--db-port <port>', 'Database port', String(config.database.port))
  .option('--db-user <user>', 'Database user', config.database.user)
  .option('--db-password <password>', 'Database password', config.database.password)
  .option('--db-name <name>', 'Database name', config.database.database)
  .option('--scan-id <id>', 'Process only files from specific scan session')
  .option('--limit <number>', 'Limit number of files to process', '0')
  .option('--skip-existing', 'Skip files that already have metadata', false)
  .option('--threads <number>', 'Number of worker threads to use', '4')
  .option('--batch-size <number>', 'Files per worker thread', '50')
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Force database connection
      const db = new DatabaseManager({
        host: options.dbHost,
        port: parseInt(options.dbPort),
        user: options.dbUser,
        password: options.dbPassword,
        database: options.dbName
      });
      
      await db.connect();
      await db.initializeTables();
      
      spinner.text = 'Loading files from database...';
      
      // Build query to get files without media metadata
      let query = `
        SELECT sf.id, sf.path, sf.name, sf.extension
        FROM scanned_files sf
        WHERE sf.extension IN (
          'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'heic', 'heif',
          'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'wma', 'opus',
          'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg'
        )
      `;
      
      const params = [];
      
      if (options.scanId) {
        query += ' AND sf.scan_id = ?';
        params.push(parseInt(options.scanId));
      }
      
      if (options.skipExisting) {
        query += ` AND sf.id NOT IN (
          SELECT file_id FROM photo_metadata
          UNION SELECT file_id FROM music_metadata
          UNION SELECT file_id FROM video_metadata
        )`;
      }
      
      if (options.limit && parseInt(options.limit) > 0) {
        query += ' LIMIT ?';
        params.push(parseInt(options.limit));
      }

      const [files] = await db.connection.query(query, params);
      
      if (files.length === 0) {
        spinner.succeed('No media files found to process');
        await db.close();
        return;
      }
      
      spinner.text = `Found ${files.length} media files. Starting extraction...`;
      
      const numThreads = parseInt(options.threads || '4');
      const batchSize = parseInt(options.batchSize || '50');
      
      // Create batches for worker threads
      const batches = [];
      for (let i = 0; i < files.length; i += batchSize) {
        batches.push(files.slice(i, i + batchSize));
      }
      
      console.log(chalk.cyan(`\nUsing ${numThreads} worker threads with ${batches.length} batches (${batchSize} files per batch)`));
      
      // Process batches with worker threads
      let totalProcessed = 0;
      let totalExtracted = 0;
      let totalSkipped = 0;
      let totalErrors = 0;
      let activeWorkers = 0;
      
      const workerPromises = [];
      const workerPath = join(__dirname, '..', 'media-worker.js');
      
      // Function to process a batch with a worker
      const processBatch = async (batch, batchIndex) => {
        return new Promise((resolve, reject) => {
          const worker = new Worker(workerPath, {
            workerData: {
              files: batch,
              dbConfig: {
                host: options.dbHost,
                port: parseInt(options.dbPort),
                user: options.dbUser,
                password: options.dbPassword,
                database: options.dbName
              }
            }
          });
          
          activeWorkers++;
          
          worker.on('message', (message) => {
            if (message.type === 'progress') {
              const globalProgress = totalProcessed + message.data.processed;
              spinner.text = `Processing ${globalProgress}/${files.length}: ${message.data.filename} (${activeWorkers} workers active)`;
            } else if (message.type === 'complete') {
              activeWorkers--;
              resolve(message.data);
            } else if (message.type === 'error') {
              activeWorkers--;
              reject(new Error(message.data.error));
            }
          });
          
          worker.on('error', (error) => {
            activeWorkers--;
            reject(error);
          });
          
          worker.on('exit', (code) => {
            if (code !== 0) {
              activeWorkers--;
              reject(new Error(`Worker stopped with exit code ${code}`));
            }
          });
        });
      };
      
      // Process batches in parallel with limited concurrency
      for (let i = 0; i < batches.length; i += numThreads) {
        const batchGroup = batches.slice(i, i + numThreads);
        const batchPromises = batchGroup.map((batch, index) => 
          processBatch(batch, i + index)
        );
        
        try {
          const results = await Promise.all(batchPromises);
          
          // Aggregate results
          for (const result of results) {
            totalProcessed += result.processed;
            totalExtracted += result.extracted;
            totalSkipped += result.skipped;
            totalErrors += result.errors;
            
            // Log any errors
            for (const error of result.errorDetails) {
              console.log(chalk.red(`\nError processing ${error.file}: ${error.error}`));
            }
          }
          
          console.log(chalk.green(`\nCompleted batch group ${Math.floor(i/numThreads) + 1}/${Math.ceil(batches.length/numThreads)} - Extracted: ${totalExtracted}/${files.length}`));
          
        } catch (err) {
          console.error(chalk.red(`\nBatch processing error: ${err.message}`));
          totalErrors++;
        }
      }
      
      spinner.succeed('Multi-threaded media metadata extraction complete!');
      
      console.log(chalk.yellow('\n=== Extraction Summary ===\n'));
      console.log(chalk.white(`Total files processed: ${totalProcessed}`));
      console.log(chalk.green(`Successfully extracted: ${totalExtracted}`));
      console.log(chalk.gray(`Skipped: ${totalSkipped}`));
      if (totalErrors > 0) {
        console.log(chalk.red(`Errors: ${totalErrors}`));
      }
      console.log(chalk.cyan(`\nPerformance: Used ${numThreads} worker threads processing ${batches.length} batches`));
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Extraction failed');
      console.error(chalk.red(`Error: ${err.message}`));
      if (db) {
        await db.close();
      }
      process.exit(1);
    }
  });

program.parse();
