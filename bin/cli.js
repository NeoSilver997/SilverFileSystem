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
import { ReportGenerator } from '../lib/report.js';
import { PhotoLibraryGenerator } from '../lib/photo-ui.js';
import { MusicPlayerGenerator } from '../lib/music-ui.js';
import { MoviePlayerGenerator } from '../lib/movie-ui.js';
import { formatBytes, truncatePath, loadConfig } from '../lib/utils.js';
import { shouldSkipMissingDeletion } from '../lib/drive-online.js';
import fs from 'fs/promises';

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
  .option('--extract-media', 'Extract media metadata', false)
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
        
        // Rebuild folder tree
        spinner.start('Rebuilding folder tree...');
        await db.rebuildFolderTree();
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
  .option('--log-file <path>', 'Save detailed logs to file')
  .option('--verbose', 'Show detailed progress and skip/error information', false)
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    // Initialize logging
    let logFile = null;
    if (options.logFile) {
      const fs = await import('fs/promises');
      logFile = options.logFile;
      await fs.writeFile(logFile, `Media Extraction Log - ${new Date().toISOString()}\n${'='.repeat(50)}\n`);
    }
    
    const logToFile = async (message) => {
      if (logFile) {
        const fs = await import('fs/promises');
        await fs.appendFile(logFile, `${new Date().toISOString()} - ${message}\n`);
      }
    };
    
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
          let batchErrors = 0;
          let batchSkipped = 0;
          
          for (const result of results) {
            totalProcessed += result.processed;
            totalExtracted += result.extracted;
            totalSkipped += result.skipped;
            totalErrors += result.errors;
            
            batchErrors += result.errors;
            batchSkipped += result.skipped;
            
            // Log detailed error information
            for (const error of result.errorDetails) {
              const errorMsg = `❌ Error processing ${error.file}: ${error.error}`;
              if (options.verbose) {
                console.log(chalk.red(`\n${errorMsg}`));
                console.log(chalk.red(`   Path: ${error.path}`));
                if (error.stack && process.env.NODE_ENV === 'development') {
                  console.log(chalk.gray(`   Stack: ${error.stack.split('\n')[0]}`));
                }
              }
              await logToFile(`ERROR: ${error.file} | Path: ${error.path} | Error: ${error.error}`);
            }
            
            // Log detailed skip information
            for (const skip of result.skippedDetails || []) {
              const skipMsg = `⚠️  Skipped ${skip.file}: ${skip.reason}`;
              if (options.verbose) {
                console.log(chalk.yellow(`\n${skipMsg}`));
                console.log(chalk.yellow(`   Path: ${skip.path}`));
                if (skip.error) {
                  console.log(chalk.yellow(`   Details: ${skip.error}`));
                }
              }
              await logToFile(`SKIP: ${skip.file} | Path: ${skip.path} | Reason: ${skip.reason} | Details: ${skip.error || 'N/A'}`);
            }
          }
          
          // Summary for this batch group
          const batchExtracted = results.reduce((sum, r) => sum + r.extracted, 0);
          console.log(chalk.green(`\n✅ Completed batch group ${Math.floor(i/numThreads) + 1}/${Math.ceil(batches.length/numThreads)}`));
          console.log(chalk.green(`   Extracted: ${batchExtracted} | Skipped: ${batchSkipped} | Errors: ${batchErrors}`));
          console.log(chalk.cyan(`   Total Progress: ${totalExtracted}/${files.length} extracted`));
          
        } catch (err) {
          console.error(chalk.red(`\nBatch processing error: ${err.message}`));
          totalErrors++;
        }
      }
      
      spinner.succeed('Multi-threaded media metadata extraction complete!');
      
      console.log(chalk.yellow('\n📊 === Extraction Summary === 📊\n'));
      console.log(chalk.white(`📁 Total files processed: ${chalk.bold(totalProcessed)}`));
      console.log(chalk.green(`✅ Successfully extracted: ${chalk.bold(totalExtracted)} (${((totalExtracted/totalProcessed)*100).toFixed(1)}%)`));
      
      if (totalSkipped > 0) {
        console.log(chalk.yellow(`⚠️  Skipped files: ${chalk.bold(totalSkipped)} (${((totalSkipped/totalProcessed)*100).toFixed(1)}%)`));
      }
      
      if (totalErrors > 0) {
        console.log(chalk.red(`❌ Error files: ${chalk.bold(totalErrors)} (${((totalErrors/totalProcessed)*100).toFixed(1)}%)`));
      }
      
      console.log(chalk.cyan(`\n⚡ Performance: Used ${numThreads} worker threads processing ${batches.length} batches`));
      console.log(chalk.cyan(`📈 Throughput: ${(totalProcessed/batches.length).toFixed(1)} files per batch`));
      
      // Final recommendations
      if (totalSkipped > totalExtracted * 0.1) {
        console.log(chalk.yellow(`\n💡 Notice: High skip rate (${((totalSkipped/totalProcessed)*100).toFixed(1)}%). Check file accessibility or format support.`));
      }
      
      if (totalErrors > totalProcessed * 0.05) {
        console.log(chalk.red(`\n⚠️  Warning: High error rate (${((totalErrors/totalProcessed)*100).toFixed(1)}%). Review error details above.`));
      }
      
      // Log final summary to file
      if (logFile) {
        await logToFile(`\n${'='.repeat(50)}`);
        await logToFile(`SUMMARY: Processed: ${totalProcessed} | Extracted: ${totalExtracted} | Skipped: ${totalSkipped} | Errors: ${totalErrors}`);
        await logToFile(`SUCCESS_RATE: ${((totalExtracted/totalProcessed)*100).toFixed(1)}%`);
        console.log(chalk.cyan(`\n📝 Detailed logs saved to: ${logFile}`));
      }
      
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

// Find duplicates from database command
program
  .command('find-duplicates-db')
  .description('Find duplicate files from existing database records')
  .option('-m, --min-size <bytes>', 'Minimum file size to check (in bytes)', '0')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .option('--report <path>', 'Generate HTML report at specified path')
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      });
      
      await db.connect();
      spinner.text = 'Querying duplicate files...';
      
      const minSize = parseInt(options.minSize || '0');
      const duplicates = await db.getDuplicatesDetailed(minSize);
      
      spinner.succeed('Query complete!');
      
      if (duplicates.length === 0) {
        console.log(chalk.green('\nNo duplicate files found in database!'));
        await db.close();
        return;
      }
      
      const totalWasted = duplicates.reduce((sum, group) => sum + group.wastedSpace, 0);
      const totalFiles = duplicates.reduce((sum, group) => sum + group.count, 0);
      
      console.log(chalk.yellow(`\nFound ${duplicates.length} groups of duplicate files:`));
      console.log(chalk.gray(`Total files: ${totalFiles}`));
      console.log(chalk.gray(`Wasted space: ${formatBytes(totalWasted)}\n`));
      
      duplicates.forEach((group, index) => {
        console.log(chalk.cyan(`\nGroup ${index + 1} (${group.count} files, ${formatBytes(group.size)} each, ${formatBytes(group.wastedSpace)} wasted):`));
        group.files.forEach(file => {
          console.log(chalk.white(`  ${truncatePath(file.path)}`));
        });
      });
      
      // Generate HTML report if requested
      if (options.report) {
        spinner.start('Generating HTML report...');
        const reportGen = new ReportGenerator();
        const reportPath = await reportGen.generateDuplicateReport(duplicates, options.report);
        spinner.succeed('HTML report generated!');
        console.log(chalk.green(`\n📄 Report saved to: ${reportPath}`));
      }
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Query failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Update hashes in database command
program
  .command('update-hashes-db')
  .description('Calculate and update file hashes for files in database (only hashes files with same size by default)')
  .option('-m, --min-size <bytes>', 'Minimum file size to process (in bytes)', '0')
  .option('-l, --limit <number>', 'Limit number of files to process', '0')
  .option('--hash-method <method>', 'Hash calculation method: full, streaming, quick, smart, sampling', 'smart')
  .option('--max-size <bytes>', 'Maximum file size to process (in bytes)', '0')
  .option('--no-smart', 'Disable smart optimization (hash all files, not just potential duplicates)')
  .option('--optimize-large', 'DEPRECATED: Use --no-smart to disable default smart optimization')
  .option('--large-threshold <bytes>', 'DEPRECATED: Smart optimization now applies to all file sizes', String(200 * 1024 * 1024))
  .option('--stats', 'Show optimization statistics before processing')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      });
      
      await db.connect();
      spinner.text = 'Loading files without hashes...';
      
      // Parse and validate parameters
      let minSize = parseInt(options.minSize || '0');
      if (isNaN(minSize) || minSize < 0) {
        minSize = 0;
      }
      
      let limit = null;
      if (options.limit) {
        const parsedLimit = parseInt(options.limit);
        if (!isNaN(parsedLimit) && parsedLimit > 0) {
          limit = parsedLimit;
        }
      }
      
      let maxSize = 0;
      if (options.maxSize) {
        const parsedMaxSize = parseInt(options.maxSize);
        if (!isNaN(parsedMaxSize) && parsedMaxSize > 0) {
          maxSize = parsedMaxSize;
        }
      }
      
      // Show deprecation warnings
      if (options.optimizeLarge) {
        console.log(chalk.yellow('\nWarning: --optimize-large is deprecated. Smart optimization is now enabled by default.'));
        console.log(chalk.yellow('Use --no-smart to disable optimization and hash all files.\n'));
      }
      
      // Show optimization statistics if requested
      if (options.stats) {
        spinner.text = 'Calculating optimization statistics...';
        const stats = await db.getSmartHashStats(minSize, maxSize);
        spinner.stop();
        console.log(chalk.cyan('\n📊 Smart Hashing Optimization Statistics:'));
        console.log(chalk.white(`   Total files without hash: ${stats.totalFiles}`));
        console.log(chalk.green(`   Files with potential duplicates (will process): ${stats.filesWithPotentialDuplicates}`));
        console.log(chalk.yellow(`   Files with unique size (will skip): ${stats.filesSkipped} (${stats.percentageSkipped}%)`));
        console.log();
        spinner.start();
      }
      
      // Use smart optimization by default (only hash files with same size)
      // Use --no-smart to disable and hash all files
      const useSmart = options.smart !== false;
      const files = useSmart
        ? await db.getFilesWithoutHashSmart(minSize, maxSize, limit)
        : await db.getFilesWithoutHash(minSize, maxSize, limit);
      
      if (files.length === 0) {
        spinner.succeed(useSmart ? 'No files with potential duplicates found!' : 'No files without hashes found!');
        await db.close();
        return;
      }
      
      const hashMethod = options.hashMethod || 'smart';
      const optimizationMsg = useSmart ? ' (smart: only files with same size)' : ' (processing all files)';
      spinner.text = `Found ${files.length} files. Calculating hashes using ${hashMethod} method${optimizationMsg}...`;
      
      const scanner = new FileScanner();
      let processed = 0;
      let updated = 0;
      let errors = 0;
      let deleted = 0;
      let skippedLarge = 0;
      
      for (const file of files) {
        try {
          // Calculate hashes based on selected method
          let hash, quickHash;
          
          switch (hashMethod) {
            case 'full':
              hash = await scanner.calculateHash(file.path);
              quickHash = await scanner.calculateQuickHash(file.path);
              break;
            case 'streaming':
              hash = await scanner.calculateStreamingHash(file.path);
              quickHash = await scanner.calculateQuickHash(file.path);
              break;
            case 'quick':
              hash = await scanner.calculateQuickHash(file.path);
              quickHash = hash; // Same as full hash for quick method
              break;
            case 'sampling':
              hash = await scanner.calculateSamplingHash(file.path);
              quickHash = await scanner.calculateQuickHash(file.path);
              break;
            case 'smart':
            default:
              hash = await scanner.calculateSmartHash(file.path);
              quickHash = await scanner.calculateQuickHash(file.path);
              break;
          }
          
          // Update database
          await db.updateFileHash(file.id, hash, quickHash);
          
          updated++;
          processed++;
          spinner.text = `Processing ${processed}/${files.length} - Updated: ${updated}, Errors: ${errors} (${hashMethod})`;
        } catch (err) {
          if (err.code === 'ENOENT') {
            if (shouldSkipMissingDeletion(file.path)) {
              errors++;
              console.warn(chalk.yellow(`\nSkipped delete (drive offline): ${file.path}`));
            } else {
              deleted++;
              await db.archiveDeletedFiles([{ id: file.id, name: file.path?.split(/[/\\]/).pop(), path: file.path }], 'update-hashes');
              await db.deleteFile(file.id);
              console.warn(chalk.red(`\nDeleted (not found): ${file.path}`));
            }
          } else {
            errors++;
            console.warn(chalk.yellow(`\nWarning: ${file.path}: ${err.message}`));
          }
          processed++;
          spinner.text = `Processing ${processed}/${files.length} - Updated: ${updated}, Deleted: ${deleted}, Errors: ${errors} (${hashMethod})`;
        }
      }
      
      spinner.succeed('Hash update complete!');
      
      console.log(chalk.green(`\n✓ Updated ${updated} file hashes (${hashMethod} method)`));
      if (deleted > 0) {
        console.log(chalk.red(`✗ Deleted ${deleted} missing files from database`));
      }
      if (useSmart) {
        console.log(chalk.cyan(`ℹ Smart optimization: Only hashed files with same size (potential duplicates)`));
        console.log(chalk.cyan(`  Use --no-smart to hash all files, or --stats to see optimization impact`));
      }
      if (errors > 0) {
        console.log(chalk.yellow(`⚠ ${errors} files had errors (read permission or other issues)`));
      }
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Update failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Generate HTML report from database command
program
  .command('generate-report')
  .description('Generate interactive HTML report for duplicate files from database')
  .argument('<output>', 'Output HTML file path')
  .option('-m, --min-size <bytes>', 'Minimum file size to include (in bytes)', '0')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (output, options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      });
      
      await db.connect();
      spinner.text = 'Querying duplicate files...';
      
      const minSize = parseInt(options.minSize || '0');
      const duplicates = await db.getDuplicatesDetailed(minSize);
      
      if (duplicates.length === 0) {
        spinner.warn('No duplicate files found in database!');
        await db.close();
        return;
      }
      
      spinner.text = 'Generating HTML report...';
      
      const reportGen = new ReportGenerator();
      const reportPath = await reportGen.generateDuplicateReport(duplicates, output);
      
      spinner.succeed('Report generated successfully!');
      
      const totalWasted = duplicates.reduce((sum, group) => sum + group.wastedSpace, 0);
      const totalFiles = duplicates.reduce((sum, group) => sum + group.count, 0);
      
      console.log(chalk.green(`\n📄 Report saved to: ${reportPath}`));
      console.log(chalk.cyan(`\n📊 Statistics:`));
      console.log(chalk.white(`   Duplicate groups: ${duplicates.length}`));
      console.log(chalk.white(`   Total files: ${totalFiles}`));
      console.log(chalk.white(`   Wasted space: ${formatBytes(totalWasted)}`));
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Report generation failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Report files by size and name command
program
  .command('report-by-size')
  .description('Report files grouped by size and name (potential duplicates)')
  .option('-m, --min-size <bytes>', 'Minimum file size to include (in bytes)', '0')
  .option('-l, --limit <number>', 'Limit number of groups to show', '0')
  .option('--format <type>', 'Output format: table, json, csv', 'table')
  .option('--names-only', 'Show only filename and size (no paths)')
  .option('--sizes-only', 'Group by size only (ignore filenames)')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      });
      
      await db.connect();
      spinner.text = 'Fetching file data...';
      
      const minSize = parseInt(options.minSize || '0');
      const limit = parseInt(options.limit || '0') || null;
      
      let groups;
      if (options.sizesOnly) {
        groups = await db.getFilesBySize(minSize);
      } else {
        groups = await db.getFilesBySizeAndName(minSize);
      }
      
      if (limit && limit > 0) {
        groups = groups.slice(0, limit);
      }
      
      spinner.succeed('Report generated!');
      
      if (groups.length === 0) {
        console.log(chalk.yellow('\nNo duplicate files found with the specified criteria.'));
        await db.close();
        return;
      }
      
      // Display results based on format
      if (options.format === 'json') {
        console.log(JSON.stringify(groups, null, 2));
      } else if (options.format === 'csv') {
        console.log('Name,Size (bytes),Size (formatted),Count,Paths');
        groups.forEach(group => {
          const name = options.sizesOnly ? 'Multiple files' : group.name;
          const paths = options.sizesOnly 
            ? group.files.map(f => f.path).join('; ')
            : (options.namesOnly ? 'Multiple locations' : group.paths.join('; '));
          console.log(`"${name}",${group.size},"${formatBytes(group.size)}",${group.count},"${paths}"`);
        });
      } else {
        // Table format
        console.log(chalk.yellow('\n=== Files by Size and Name Report ===\n'));
        
        let totalFiles = 0;
        let totalWastedSpace = 0;
        
        groups.forEach((group, index) => {
          const wastedSpace = (group.count - 1) * group.size;
          totalFiles += group.count;
          totalWastedSpace += wastedSpace;
          
          console.log(chalk.cyan(`${index + 1}. ${options.sizesOnly ? 'Files of size' : 'File'}: ${options.sizesOnly ? '' : group.name}`));
          console.log(chalk.white(`   Size: ${formatBytes(group.size)} (${group.size.toLocaleString()} bytes)`));
          console.log(chalk.white(`   Count: ${group.count} copies`));
          console.log(chalk.white(`   Wasted space: ${formatBytes(wastedSpace)}`));
          
          if (!options.namesOnly) {
            console.log(chalk.gray('   Locations:'));
            if (options.sizesOnly) {
              group.files.slice(0, 10).forEach(file => {
                console.log(chalk.gray(`     ${file.name} - ${file.path}`));
              });
              if (group.files.length > 10) {
                console.log(chalk.gray(`     ... and ${group.files.length - 10} more files`));
              }
            } else {
              group.paths.slice(0, 10).forEach(path => {
                console.log(chalk.gray(`     ${path}`));
              });
              if (group.paths.length > 10) {
                console.log(chalk.gray(`     ... and ${group.paths.length - 10} more locations`));
              }
            }
          }
          console.log();
        });
        
        console.log(chalk.green(`📊 Summary:`));
        console.log(chalk.white(`   Total groups: ${groups.length}`));
        console.log(chalk.white(`   Total files: ${totalFiles}`));
        console.log(chalk.white(`   Total wasted space: ${formatBytes(totalWastedSpace)}`));
      }
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Report generation failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Generate folder-grouped HTML report from database command
program
  .command('report-by-folder')
  .description('Generate HTML report of duplicate files grouped by folder')
  .argument('<output>', 'Output HTML file path')
  .option('-m, --min-size <bytes>', 'Minimum file size to include (in bytes)', '0')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (output, options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      });
      
      await db.connect();
      spinner.text = 'Fetching duplicate files by folder...';
      
      const minSize = parseInt(options.minSize || '0');
      const folderGroups = await db.getDuplicatesByFolder(minSize);
      
      spinner.text = 'Generating HTML report...';
      const reportGen = new ReportGenerator();
      const reportPath = await reportGen.generateFolderDuplicateReport(folderGroups, output);
      
      spinner.succeed('Folder report generated!');
      
      const totalFolders = folderGroups.length;
      const totalFiles = folderGroups.reduce((sum, folder) => sum + folder.totalFiles, 0);
      const totalWasted = folderGroups.reduce((sum, folder) => sum + folder.totalWastedSpace, 0);
      
      console.log(chalk.green(`\n📁 Report saved to: ${reportPath}`));
      console.log(chalk.cyan(`\n📊 Statistics:`));
      console.log(chalk.white(`   Folders with duplicates: ${totalFolders}`));
      console.log(chalk.white(`   Total duplicate files: ${totalFiles}`));
      console.log(chalk.white(`   Total wasted space: ${formatBytes(totalWasted)}`));
      
      if (folderGroups.length > 0) {
        console.log(chalk.yellow(`\n🔥 Top folders by wasted space:`));
        folderGroups.slice(0, 5).forEach((folder, index) => {
          console.log(chalk.white(`   ${index + 1}. ${folder.folderPath}: ${formatBytes(folder.totalWastedSpace)}`));
        });
      }
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Report generation failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Generate HTML report for duplicates by name and size
program
  .command('report-by-name-size')
  .description('Generate interactive HTML report for files with same name and size in different locations')
  .argument('<output>', 'Output HTML file path')
  .option('-m, --min-size <bytes>', 'Minimum file size to include (in bytes)', '0')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (output, options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      });
      
      await db.connect();
      spinner.text = 'Fetching duplicates by name and size...';
      
      const minSize = parseInt(options.minSize || '0');
      const duplicates = await db.getDuplicatesByNameAndSize(minSize);
      
      if (duplicates.length === 0) {
        spinner.warn('No duplicate files found with same name and size!');
        await db.close();
        return;
      }
      
      spinner.text = 'Generating HTML report...';
      const reportGen = new ReportGenerator();
      const reportPath = await reportGen.generateNameSizeDuplicateReport(duplicates, output);
      
      spinner.succeed('Report generated successfully!');
      
      const totalFiles = duplicates.reduce((sum, group) => sum + group.count, 0);
      const totalWasted = duplicates.reduce((sum, group) => sum + group.wastedSpace, 0);
      
      console.log(chalk.green(`\n📄 Report saved to: ${reportPath}`));
      console.log(chalk.cyan(`\n📊 Statistics:`));
      console.log(chalk.white(`   Unique file names: ${duplicates.length}`));
      console.log(chalk.white(`   Total duplicate locations: ${totalFiles}`));
      console.log(chalk.white(`   Wasted space: ${formatBytes(totalWasted)}`));
      
      if (duplicates.length > 0) {
        console.log(chalk.yellow(`\n🔥 Top duplicates by wasted space:`));
        duplicates.slice(0, 5).forEach((dup, index) => {
          console.log(chalk.white(`   ${index + 1}. ${dup.name}: ${formatBytes(dup.wastedSpace)} (${dup.count} locations)`));
        });
      }
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Report generation failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Detect completely duplicated folders
program
  .command('find-duplicate-folders')
  .description('Find folders that are completely duplicated (identical content)')
  .option('-m, --min-size <bytes>', 'Minimum file size to include (in bytes)', '0')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      });
      
      await db.connect();
      spinner.text = 'Analyzing folders for duplicates...';
      
      const minSize = parseInt(options.minSize || '0');
      const duplicateFolders = await db.getCompleteDuplicateFolders(minSize);
      
      spinner.succeed('Analysis complete!');
      
      if (duplicateFolders.length === 0) {
        console.log(chalk.green('\n✓ No completely duplicated folders found!'));
        await db.close();
        return;
      }
      
      const totalWasted = duplicateFolders.reduce((sum, group) => sum + group.wastedSpace, 0);
      
      console.log(chalk.yellow(`\n📁 Found ${duplicateFolders.length} sets of duplicate folders:\n`));
      
      duplicateFolders.forEach((group, index) => {
        console.log(chalk.cyan(`\nDuplicate Set ${index + 1}:`));
        console.log(chalk.white(`  Files: ${group.fileCount}, Total Size: ${formatBytes(group.totalSize)}`));
        console.log(chalk.red(`  Wasted Space: ${formatBytes(group.wastedSpace)}`));
        console.log(chalk.gray(`  Duplicate Locations (${group.count}):`));
        group.folders.forEach((folder, idx) => {
          console.log(chalk.white(`    ${idx + 1}. ${folder.folderPath}`));
        });
      });
      
      console.log(chalk.yellow(`\n📊 Summary:`));
      console.log(chalk.white(`   Total duplicate folder sets: ${duplicateFolders.length}`));
      console.log(chalk.white(`   Total wasted space: ${formatBytes(totalWasted)}`));
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Analysis failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Generate photo library UI command
program
  .command('generate-photo-library')
  .description('Generate interactive photo library web UI from database')
  .argument('<output>', 'Output HTML file path')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (output, options) => {
    const spinner = ora('Generating photo library UI...').start();
    
    try {
      // Connect to database
      const dbConfig = {
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      };
      
      const db = new DatabaseManager(dbConfig);
      await db.connect();
      
      spinner.text = 'Retrieving photos from database...';
      const photos = await db.getPhotosWithMetadata();
      
      if (photos.length === 0) {
        spinner.warn('No photos with metadata found in database');
        await db.close();
        console.log(chalk.yellow('\nℹ️  Tip: Use "scan --db --extract-media" to extract photo metadata first'));
        return;
      }
      
      spinner.text = 'Calculating statistics...';
      
      // Calculate statistics
      const totalSize = photos.reduce((sum, p) => sum + Number(p.size), 0);
      const uniqueCameras = new Set(photos.map(p => p.camera_make).filter(Boolean)).size;
      const withGPS = photos.filter(p => p.latitude !== null).length;
      
      const stats = {
        totalPhotos: photos.length,
        totalSize: formatBytes(totalSize),
        uniqueCameras,
        withGPS
      };
      
      spinner.text = 'Generating HTML...';
      const html = PhotoLibraryGenerator.generateHTML(photos, stats);
      
      await fs.writeFile(output, html);
      await db.close();
      
      spinner.succeed(`Photo library UI generated successfully!`);
      console.log(chalk.green(`\n✓ Output file: ${output}`));
      console.log(chalk.cyan(`  📷 ${photos.length} photos`));
      console.log(chalk.cyan(`  📁 ${formatBytes(totalSize)}`));
      console.log(chalk.gray(`\nOpen the file in a web browser to view your photo library.`));
      
    } catch (err) {
      spinner.fail('Generation failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
      process.exit(1);
    }
  });

// Generate music player UI command
program
  .command('generate-music-player')
  .description('Generate interactive music player web UI from database')
  .argument('<output>', 'Output HTML file path')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (output, options) => {
    const spinner = ora('Generating music player UI...').start();
    
    try {
      // Connect to database
      const dbConfig = {
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      };
      
      const db = new DatabaseManager(dbConfig);
      await db.connect();
      
      spinner.text = 'Retrieving music tracks from database...';
      const tracks = await db.getMusicWithMetadata();
      
      if (tracks.length === 0) {
        spinner.warn('No music tracks with metadata found in database');
        await db.close();
        console.log(chalk.yellow('\nℹ️  Tip: Use "scan --db --extract-media" to extract music metadata first'));
        return;
      }
      
      spinner.text = 'Calculating statistics...';
      
      // Calculate statistics
      const totalSize = tracks.reduce((sum, t) => sum + Number(t.size), 0);
      const totalDuration = tracks.reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
      const uniqueAlbums = new Set(tracks.map(t => t.album).filter(Boolean)).size;
      const uniqueArtists = new Set(tracks.map(t => t.artist).filter(Boolean)).size;
      
      const hours = Math.floor(totalDuration / 3600);
      const mins = Math.floor((totalDuration % 3600) / 60);
      
      const stats = {
        totalTracks: tracks.length,
        totalAlbums: uniqueAlbums,
        totalArtists: uniqueArtists,
        totalDuration: `${hours}h ${mins}m`,
        totalSize: formatBytes(totalSize)
      };
      
      spinner.text = 'Generating HTML...';
      const html = MusicPlayerGenerator.generateHTML(tracks, stats);
      
      await fs.writeFile(output, html);
      await db.close();
      
      spinner.succeed(`Music player UI generated successfully!`);
      console.log(chalk.green(`\n✓ Output file: ${output}`));
      console.log(chalk.cyan(`  🎵 ${tracks.length} tracks`));
      console.log(chalk.cyan(`  💿 ${uniqueAlbums} albums`));
      console.log(chalk.cyan(`  🎤 ${uniqueArtists} artists`));
      console.log(chalk.cyan(`  ⏱  ${hours}h ${mins}m total duration`));
      console.log(chalk.gray(`\nOpen the file in a web browser to view your music collection.`));
      
    } catch (err) {
      spinner.fail('Generation failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
      process.exit(1);
    }
  });

// Generate movie player UI command
program
  .command('generate-movie-player')
  .description('Generate interactive movie player web UI from database')
  .argument('<output>', 'Output HTML file path')
  .option('--db-host <host>', `Database host (default: ${config.database.host})`)
  .option('--db-port <port>', `Database port (default: ${config.database.port})`)
  .option('--db-user <user>', `Database user (default: ${config.database.user})`)
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', `Database name (default: ${config.database.database})`)
  .action(async (output, options) => {
    const spinner = ora('Generating movie player UI...').start();
    
    try {
      // Connect to database
      const dbConfig = {
        host: options.dbHost || config.database.host,
        port: parseInt(options.dbPort || config.database.port),
        user: options.dbUser || config.database.user,
        password: options.dbPassword || config.database.password,
        database: options.dbName || config.database.database
      };
      
      const db = new DatabaseManager(dbConfig);
      await db.connect();
      
      spinner.text = 'Retrieving movies from database...';
      const movies = await db.getVideosWithMetadata();
      
      if (movies.length === 0) {
        spinner.warn('No movies with metadata found in database');
        await db.close();
        console.log(chalk.yellow('\nℹ️  Tip: Use "scan --db --extract-media" to extract video metadata first'));
        return;
      }
      
      spinner.text = 'Calculating statistics...';
      
      // Calculate statistics
      const totalSize = movies.reduce((sum, m) => sum + Number(m.size), 0);
      const totalDuration = movies.reduce((sum, m) => sum + (Number(m.duration) || 0), 0);
      const hdCount = movies.filter(m => m.width >= 1280 && m.width < 3840).length;
      const fourKCount = movies.filter(m => m.width >= 3840).length;
      
      const hours = Math.floor(totalDuration / 3600);
      const mins = Math.floor((totalDuration % 3600) / 60);
      
      const stats = {
        totalMovies: movies.length,
        totalDuration: `${hours}h ${mins}m`,
        totalSize: formatBytes(totalSize),
        hdCount,
        fourKCount
      };
      
      spinner.text = 'Generating HTML...';
      const html = MoviePlayerGenerator.generateHTML(movies, stats);
      
      await fs.writeFile(output, html);
      await db.close();
      
      spinner.succeed(`Movie player UI generated successfully!`);
      console.log(chalk.green(`\n✓ Output file: ${output}`));
      console.log(chalk.cyan(`  🎬 ${movies.length} movies`));
      console.log(chalk.cyan(`  📺 ${hdCount} HD, ${fourKCount} 4K`));
      console.log(chalk.cyan(`  ⏱  ${hours}h ${mins}m total duration`));
      console.log(chalk.gray(`\nOpen the file in a web browser to view your movie collection.`));
      
    } catch (err) {
      spinner.fail('Generation failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
      process.exit(1);
    }
  });

// Rebuild folder tree command
program
  .command('rebuild-folder-tree')
  .description('Rebuild the folder_tree table from scanned_files')
  .option('--db', 'Use database')
  .option('--db-host <host>', 'Database host')
  .option('--db-port <port>', 'Database port')
  .option('--db-user <user>', 'Database user')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name')
  .action(async (options) => {
    await initDatabase(options);
    
    if (!dbManager) {
      console.error(chalk.red('Database connection required. Use --db flag.'));
      process.exit(1);
    }
    
    const spinner = ora('Rebuilding folder tree...').start();
    
    try {
      await dbManager.rebuildFolderTree();
      spinner.succeed('Folder tree rebuilt successfully!');
      
      const [count] = await dbManager.connection.query('SELECT COUNT(*) as c FROM folder_tree');
      const [drives] = await dbManager.connection.query('SELECT COUNT(*) as c FROM folder_tree WHERE depth = 1');
      console.log(chalk.cyan(`  📁 ${count[0].c.toLocaleString()} folders indexed`));
      console.log(chalk.cyan(`  💾 ${drives[0].c} drives`));
      
      await dbManager.close();
    } catch (err) {
      spinner.fail('Rebuild failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
    }
  });

// VLM Photo Classification command
program
  .command('classify')
  .description('Classify photos using local VLM (LM Studio)')
  .argument('<directory>', 'Directory containing photos to classify')
  .option('-o, --output <path>', 'Output directory for classified photos', './photo_library')
  .option('-m, --model <name>', 'VLM model name', 'google/gemma-4-12b-qat')
  .option('--lmstudio-url <url>', 'LM Studio API URL', 'http://localhost:12355')
  .option('--dry-run', 'Preview classification without moving files')
  .option('--db', 'Store results in database')
  .option('--db-host <host>', 'Database host')
  .option('--db-port <port>', 'Database port')
  .option('--db-user <user>', 'Database user')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name')
  .action(async (directory, options) => {
    await initDatabase(options);

    const { PhotoClassifier } = await import('../lib/photo-classifier.js');
    const { exiftool } = await import('exiftool-vendored');
    const path = await import('path');
    const fsAsync = await import('fs/promises');

    const classifier = new PhotoClassifier({
      vlm: {
        lmstudioUrl: options.lmstudioUrl,
        model: options.model
      },
      outputBase: options.output,
      dryRun: options.dryRun
    });

    console.log(chalk.cyan('\nSilverFileSystem VLM Photo Classifier'));
    console.log(chalk.gray(`  Source:  ${directory}`));
    console.log(chalk.gray(`  Output: ${options.output}`));
    console.log(chalk.gray(`  Model:  ${options.model}`));
    console.log(chalk.gray(`  Mode:   ${options.dryRun ? 'DRY RUN' : 'LIVE'}\n`));

    const spinner = ora('Scanning for images...').start();

    try {
      const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'heic', 'heif']);
      const files = [];

      const walk = async (dir) => {
        const entries = await fsAsync.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.default.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'photo_library') {
              await walk(fullPath);
            }
          } else {
            const ext = path.default.extname(entry.name).toLowerCase().slice(1);
            if (imageExtensions.has(ext)) {
              files.push(fullPath);
            }
          }
        }
      };

      await walk(directory);
      spinner.text = `Found ${files.length} images. Starting classification...`;

      if (files.length === 0) {
        spinner.warn('No images found in directory');
        await closeDatabase();
        return;
      }

      const exifDataMap = {};
      for (const file of files) {
        try {
          const exif = await exiftool.read(file);
          exifDataMap[file] = {
            datetime: { taken: exif.DateTimeOriginal || exif.CreateDate },
            location: { latitude: exif.GPSLatitude, longitude: exif.GPSLongitude }
          };
        } catch {}
      }

      let classified = 0;
      let failed = 0;
      const categories = {};

      const { results, summary } = await classifier.batchClassify(files, exifDataMap, (progress) => {
        spinner.text = `[${progress.current}/${progress.total}] ${progress.filename} → ${progress.category || 'processing'}...`;
      });

      spinner.succeed(`Classification complete!`);

      console.log(chalk.green(`\n  ✅ Successful: ${summary.successful}`));
      console.log(chalk.red(`  ❌ Failed: ${summary.failed}`));
      console.log(chalk.cyan(`  📦 Compressed: ${summary.compressed}\n`));

      console.log(chalk.cyan('  Categories:'));
      for (const [cat, count] of Object.entries(summary.categories)) {
        console.log(chalk.gray(`    ${cat}: ${count}`));
      }

      console.log(chalk.cyan('\n  Detailed Results:'));
      for (const result of results) {
        if (result.success && result.vlmResult) {
          const v = result.vlmResult;
          console.log(chalk.white(`\n  ── ${result.filename} ──`));
          console.log(chalk.gray(`    Category:    ${v.category}`));
          if (v.subject) console.log(chalk.gray(`    Subject:     ${v.subject.slice(0, 120)}${v.subject.length > 120 ? '...' : ''}`));
          if (v.action) console.log(chalk.gray(`    Action:      ${v.action.slice(0, 120)}${v.action.length > 120 ? '...' : ''}`));
          if (v.background) console.log(chalk.gray(`    Background:  ${v.background.slice(0, 120)}${v.background.length > 120 ? '...' : ''}`));
          if (v.style) console.log(chalk.gray(`    Style:       ${v.style.slice(0, 120)}${v.style.length > 120 ? '...' : ''}`));
          if (v.tags?.length) console.log(chalk.gray(`    Tags:        ${v.tags.join(', ')}`));
          if (v.mood) console.log(chalk.gray(`    Mood:        ${v.mood}`));
          if (v.color_palette) console.log(chalk.gray(`    Colors:      ${v.color_palette}`));
          if (v.lighting) console.log(chalk.gray(`    Lighting:    ${v.lighting}`));
          if (v.camera_angle) console.log(chalk.gray(`    Camera:      ${v.camera_angle}`));
          if (v.ai_prompt) console.log(chalk.yellow(`    AI Prompt:   ${v.ai_prompt.slice(0, 150)}${v.ai_prompt.length > 150 ? '...' : ''}`));
          console.log(chalk.gray(`    → ${result.destinationPath || 'dry run'}`));
        }
      }

      if (dbManager && options.db) {
        console.log(chalk.gray('\n  Saving to database...'));
        for (const result of results) {
          if (result.success && result.vlmResult) {
            try {
              const [existing] = await dbManager.connection.execute(
                'SELECT id FROM scanned_files WHERE path = ?', [result.originalPath]
              );
              if (existing.length > 0) {
                await dbManager.storePhotoClassification(existing[0].id, result.vlmResult, {
                  ...result,
                  model: options.model,
                  rawResponse: result.vlmResult?.rawResponse || ''
                });
              }
            } catch {}
          }
        }
        console.log(chalk.green('  Database saved!'));
      }

      await closeDatabase();
    } catch (err) {
      spinner.fail('Classification failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
    }
  });

// Watch directory for new photos command
program
  .command('watch')
  .description('Watch a directory and auto-classify new photos')
  .argument('<directory>', 'Directory to watch')
  .option('-o, --output <path>', 'Output directory for classified photos', './photo_library')
  .option('-m, --model <name>', 'VLM model name', 'google/gemma-4-12b-qat')
  .option('--lmstudio-url <url>', 'LM Studio API URL', 'http://localhost:12355')
  .option('--db', 'Store results in database')
  .option('--db-host <host>', 'Database host')
  .option('--db-port <port>', 'Database port')
  .option('--db-user <user>', 'Database user')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name')
  .action(async (directory, options) => {
    await initDatabase(options);

    const { FileWatcher } = await import('../lib/file-watcher.js');

    console.log(chalk.cyan('\nSilverFileSystem VLM Photo Watcher'));
    console.log(chalk.gray(`  Watching: ${directory}`));
    console.log(chalk.gray(`  Output:  ${options.output}`));
    console.log(chalk.gray(`  Model:   ${options.model}\n`));

    const watcher = new FileWatcher({
      watchDir: directory,
      outputBase: options.output,
      vlm: {
        lmstudioUrl: options.lmstudioUrl,
        model: options.model
      },
      db: dbManager,
      onFileClassified: (result) => {
        console.log(chalk.green(`  ✅ ${result.filename} → ${result.category}`));
      }
    });

    try {
      await watcher.start();
      console.log(chalk.green('  Watching for new images... (Press Ctrl+C to stop)\n'));

      process.on('SIGINT', async () => {
        console.log(chalk.yellow('\n  Stopping watcher...'));
        const stats = watcher.getStats();
        console.log(chalk.gray(`  Stats: ${stats.classified} classified, ${stats.failed} failed`));
        await watcher.stop();
        await closeDatabase();
        process.exit(0);
      });

    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
    }
  });

// Face detection scan command
program
  .command('face-scan')
  .description('Detect faces in photos and save to database (defaults to from-db mode, multi-threaded)')
  .argument('[directory]', 'Directory to scan (omit for from-db mode, reads from .env DB)')
  .option('-l, --limit <n>', 'Max number of images to process', '50')
  .option('-c, --min-confidence <n>', 'Minimum face confidence to save (0-1)', '0.65')
  .option('-t, --threads <n>', 'Number of parallel worker threads', String(Math.min(4, (await import('os')).cpus().length)))
  .option('--filesystem', 'Force filesystem scan mode (otherwise from-db by default)')
  .option('--group', 'Show face grouping results after scan')
  .action(async (directory, options) => {
    // Auto-detect mode: if no directory and not --filesystem, use from-db
    const useFromDb = !directory || (!options.filesystem && !directory);
    if (useFromDb) options.fromDb = true;
    if (directory && !options.filesystem) options.fromDb = false;

    // Auto-load DB from .env if --db flags not provided
    if (!options.dbHost) options.db = true;

    await initDatabase(options);

    const { FaceDetector } = await import('../lib/face-detector.js');
    const fsAsync = await import('fs/promises');
    const pathMod = await import('path');

    const detector = new FaceDetector();
    const limit = parseInt(options.limit) || 50;

    console.log(chalk.cyan('\nSilverFileSystem Face Detection Scan'));
    console.log(chalk.gray(`  Mode:   ${options.fromDb ? 'from-db' : 'filesystem'}`));
    console.log(chalk.gray(`  Limit:  ${limit} images\n`));

    const spinner = ora('Loading images...').start();

    try {
      let toProcess = [];

      if (options.fromDb) {
        if (!dbManager) {
          spinner.fail('Database connection required. Use --db flag.');
          process.exit(1);
        }

        // Use scan_queue for fast querying
        const [pending] = await dbManager.connection.execute(
          `SELECT id, file_id, file_name, folder_path FROM scan_queue WHERE status = 'pending' LIMIT ${limit}`
        );

        if (pending.length === 0) {
          // Populate scan_queue from scanned_files
          spinner.text = 'Populating scan queue...';
          await dbManager.connection.execute(`
            INSERT IGNORE INTO scan_queue (file_id, file_name, folder_path, status)
            SELECT sf.id, sf.name, ft.folder_id, 'pending'
            FROM scanned_files sf
            LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
            LEFT JOIN detected_faces df ON sf.id = df.file_id
            WHERE sf.extension IN ('jpg','jpeg','heic')
            AND sf.size > 500000
            AND df.id IS NULL
            LIMIT ${limit}
          `);

          const [newPending] = await dbManager.connection.execute(
            `SELECT id, file_id, file_name, folder_path FROM scan_queue WHERE status = 'pending' LIMIT ${limit}`
          );
          pending.push(...newPending);
        }

        for (const row of pending) {
          const folderPath = (row.folder_path || '').replace(/[\\\/]$/, '');
          const fullPath = folderPath ? folderPath + '\\' + row.file_name : row.file_name;
          toProcess.push({ fileId: row.file_id, filePath: fullPath, name: row.file_name, queueId: row.id, fromDb: true });
        }

        spinner.text = `Loaded ${toProcess.length} photos from scan queue`;
      } else {
        if (!directory) {
          spinner.fail('Directory argument required in filesystem mode.');
          process.exit(1);
        }

        const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'heic', 'heif']);
        const files = [];

        const walk = async (dir) => {
          const entries = await fsAsync.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = pathMod.default.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'photo_library') {
                await walk(fullPath);
              }
            } else {
              const ext = pathMod.default.extname(entry.name).toLowerCase().slice(1);
              if (imageExtensions.has(ext)) {
                files.push(fullPath);
              }
            }
          }
        };

        await walk(directory);
        toProcess = files.slice(0, limit).map(f => ({ filePath: f, name: pathMod.default.basename(f), fromDb: false }));
        spinner.text = `Found ${files.length} images, processing ${toProcess.length}...`;
      }

      if (toProcess.length === 0) {
        spinner.warn('No images found');
        await closeDatabase();
        return;
      }

      const allResults = [];
      let totalFaces = 0;
      let scanned = 0;
      const minConf = parseFloat(options.minConfidence) || 0.65;
      const numThreads = parseInt(options.threads) || 4;
      const WORKER_SCRIPT = join(__dirname, '..', 'scripts', 'face-worker.js');

      spinner.text = `Loading images and named groups...`;

      // Load named groups for auto-matching
      let namedGroups = [];
      if (dbManager) {
        namedGroups = await detector.loadNamedGroups(dbManager);
        if (namedGroups.length > 0) {
          console.log(chalk.gray(`  📋 ${namedGroups.length} named groups loaded for auto-matching`));
        }
      }

      // Split items into chunks for parallel workers
      const chunkSize = Math.ceil(toProcess.length / numThreads);
      const chunks = [];
      for (let i = 0; i < toProcess.length; i += chunkSize) {
        chunks.push(toProcess.slice(i, i + chunkSize));
      }

      // Launch workers in parallel
      const { Worker } = await import('worker_threads');
      const workers = chunks.map(chunk => {
        return new Promise((resolve, reject) => {
          const worker = new Worker(WORKER_SCRIPT, {
            workerData: { items: chunk, minConfidence: minConf }
          });
          const chunkResults = [];
          worker.on('message', (msg) => {
            if (msg.type === 'progress') {
              spinner.text = `[${scanned + msg.current}/${toProcess.length}] Processing with ${numThreads} threads...`;
            }
            if (msg.type === 'result') {
              chunkResults.push(msg.result);
            }
            if (msg.type === 'done') {
              resolve(chunkResults);
            }
          });
          worker.on('error', reject);
        });
      });

      const allWorkerResults = await Promise.all(workers);

      // Flatten results and save to DB
      for (const results of allWorkerResults) {
        for (const result of results) {
          scanned++;
          totalFaces += result.faces?.length || 0;
          allResults.push(result);

          // Log each photo
          const faceCount = result.faces?.length || 0;
          const logEntry = {
            timestamp: new Date().toISOString(),
            file: result.name || path.basename(result.filePath),
            faces: faceCount,
            success: result.success,
            elapsed: result.elapsed || 0
          };

          if (faceCount > 0) {
            logEntry.faceDetails = result.faces.map(f => ({
              confidence: f.confidence,
              gender: f.gender,
              age: f.age_approx
            }));
          }

          console.log(chalk.gray(`  [${scanned}] ${logEntry.file}: ${faceCount} faces (${logEntry.elapsed}ms)`));

          if (dbManager && result.success) {
            try {
              const fileId = result.fileId || null;
              let dbFileId = fileId;
              if (!fileId) {
                const st = await fsAsync.stat(result.filePath);
                const [ins] = await dbManager.connection.execute(
                  'INSERT INTO scanned_files (name, size, extension, mtime, created_at) VALUES (?, ?, ?, NOW(), NOW())',
                  [result.name, st.size, pathMod.default.extname(result.filePath).slice(1)]
                );
                dbFileId = ins.insertId;
              }

              // Mark scan_queue entry as scanned
              if (result.queueId) {
                await dbManager.connection.execute(
                  'UPDATE scan_queue SET status = ?, scanned_at = NOW() WHERE id = ?',
                  ['scanned', result.queueId]
                );
              }

              // Always insert a record (even if 0 faces) so file won't be scanned again
              if (result.faces?.length > 0) {
                await dbManager.storeDetectedFaces(dbFileId, result);

                if (namedGroups.length > 0) {
                  // Load ignored face phashes to skip
                  const [ignoredRows] = await dbManager.connection.execute(`
                    SELECT JSON_EXTRACT(face_descriptor, '$.phash') as phash
                    FROM detected_faces
                    WHERE all_expressions IS NOT NULL
                    AND JSON_EXTRACT(all_expressions, '$.invalid') = true
                    AND face_descriptor IS NOT NULL
                  `);
                  const ignoredPhashes = new Set(ignoredRows.map(r => r.phash).filter(Boolean));

                  for (const face of result.faces) {
                    if (face.no_faces || face.confidence === 0) continue;
                    const facePhash = face.perceptual_hash || face.face_descriptor?.phash;
                    if (facePhash && ignoredPhashes.has(facePhash)) continue;
                    if (facePhash) {
                      const { groupId: matchGroupId, score: matchScore } = detector.findMatchingGroup(face, namedGroups);
                      if (matchGroupId) {
                        await dbManager.connection.execute(
                          'UPDATE detected_faces SET suggested_group_id = ?, match_source = ?, match_confidence = ?, match_reviewed = 0 WHERE file_id = ? AND face_index = ?',
                          [matchGroupId, 'auto', matchScore, dbFileId, face.index]
                        );
                        const [grp] = await dbManager.connection.execute('SELECT label FROM face_groups WHERE id = ?', [matchGroupId]);
                        console.log(chalk.green(`    → Matched to ${grp[0]?.label || 'group #' + matchGroupId} (score: ${matchScore.toFixed(3)})`));
                      }
                    }
                  }
                }
              } else {
                await dbManager.connection.execute(
                  'INSERT INTO detected_faces (file_id, face_index, confidence, face_descriptor) VALUES (?, 0, 0, ?)',
                  [dbFileId, JSON.stringify({ no_faces: true })]
                );
              }
            } catch (e) {
              // silent
            }
          }
        }
      }

      spinner.succeed(`Scan complete!`);

      console.log(chalk.green(`\n  ✅ Total faces: ${totalFaces}`));
      console.log(chalk.gray(`  📸 Images scanned: ${scanned}`));
      if (namedGroups.length > 0) {
        console.log(chalk.gray(`  📋 Named groups: ${namedGroups.length}`));
      }

      // Log match summary
      const matchSummary = {};
      for (const result of allResults) {
        if (result.faces?.length > 0) {
          for (const face of result.faces) {
            const facePhash = face.perceptual_hash || face.face_descriptor?.phash;
            if (facePhash) {
              const { groupId, score } = detector.findMatchingGroup(face, namedGroups);
              if (groupId) {
                const [grp] = await dbManager.connection.execute('SELECT label FROM face_groups WHERE id = ?', [groupId]);
                const label = grp[0]?.label || `group_${groupId}`;
                matchSummary[label] = (matchSummary[label] || 0) + 1;
              }
            }
          }
        }
      }

      if (Object.keys(matchSummary).length > 0) {
        console.log(chalk.cyan('\n  🎯 Match Summary:'));
        for (const [label, count] of Object.entries(matchSummary)) {
          console.log(chalk.gray(`    ${label}: ${count} faces matched`));
        }
      }

      if (options.group && allResults.length > 0) {
        console.log(chalk.cyan('\n  Face Groups:'));
        const groups = detector.groupFaces(allResults);
        for (const g of groups) {
          console.log(chalk.gray(`    ${g.label}: ${g.faceCount} faces in ${g.files.length} photos`));
        }
      }

      if (dbManager) {
        const [fc] = await dbManager.connection.execute('SELECT COUNT(*) as c FROM detected_faces');
        console.log(chalk.gray(`\n  💾 DB detected_faces: ${fc[0].c} rows`));
      }

      await closeDatabase();
      process.exit(0);
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
      process.exit(1);
    }
  });

program
  .command('face-scan-v2')
  .description('New face scan with dedup (size+md5) into faces_v2 table, uses antelopev2')
  .option('-l, --limit <n>', 'Max images to process', '100')
  .option('-c, --min-confidence <n>', 'Min face confidence (0-1)', '0.5')
  .option('-t, --threads <n>', 'Worker threads', String(Math.min(4, (await import('os')).cpus().length)))
  .option('--match', 'Auto-match to named groups after scan')
  .option('--sort <field>', 'Sort pending images by', 'newest')
  .option('--phone-only', 'Only scan phone photos (Xiaomi, HTC, Apple, Samsung)')
  .option('--since <date>', 'Only scan photos after this date (YYYY-MM-DD)', '')
  .option('--ignore-cameras <cameras>', 'Comma-separated camera makes to skip (e.g. "Apple,HTC")', '')
  .action(async (options) => {
    if (!options.dbHost) options.db = true;
    await initDatabase(options);

    const { FaceDetector } = await import('../lib/face-detector.js');
    const crypto = await import('crypto');
    const fsAsync = await import('fs/promises');
    const pathMod = await import('path');

    const detector = new FaceDetector({ model: 'antelopev2' });
    const limit = parseInt(options.limit) || 100;
    const minConf = parseFloat(options.minConfidence) || 0.5;
    const numThreads = parseInt(options.threads) || 4;
    const phoneOnly = options.phoneOnly || false;
    const since = options.since || '';
    const ignoreCameras = options.ignoreCameras ? options.ignoreCameras.split(',').map(c => c.trim()).filter(Boolean) : [];

    // Load ignored cameras from DB
    if (dbManager) {
      try {
        const [dbIgnored] = await dbManager.connection.execute('SELECT camera_make FROM ignored_cameras');
        for (const row of dbIgnored) {
          if (row.camera_make && !ignoreCameras.includes(row.camera_make)) {
            ignoreCameras.push(row.camera_make);
          }
        }
      } catch {}
    }

    // Build camera filter
    let cameraFilter = phoneOnly
      ? `AND (pm.camera_make LIKE '%Xiaomi%' OR pm.camera_make LIKE '%HTC%' OR pm.camera_make LIKE '%Apple%' OR pm.camera_make LIKE '%samsung%')`
      : '';
    if (ignoreCameras.length > 0) {
      const ignoreConditions = ignoreCameras.map(c => `pm.camera_make NOT LIKE '%${c}%'`).join(' AND ');
      cameraFilter += ` AND (${ignoreConditions})`;
    }
    const dateFilter = since ? `AND sf.mtime >= '${since}'` : '';

    console.log(chalk.cyan('\nSilverFileSystem Face Detection V2'));
    console.log(chalk.gray(`  Model:  antelopev2 (primary)`));
    console.log(chalk.gray(`  Limit:  ${limit} images`));
    console.log(chalk.gray(`  Dedup:  size + md5`));
    if (phoneOnly) console.log(chalk.gray(`  Filter: phone-only (Xiaomi/HTC/Apple/Samsung)`));
    if (since) console.log(chalk.gray(`  Since:  ${since}`));
    if (ignoreCameras.length > 0) console.log(chalk.gray(`  Ignore: ${ignoreCameras.join(', ')}`));
    console.log('');

    const spinner = ora('Loading pending images...').start();

    try {
      // Compute md5 for files that don't have it yet
      spinner.text = 'Computing md5 for unprocessed files...';
      const [noMd5] = await dbManager.connection.execute(
        `SELECT sf.id, sf.name, COALESCE(sq.folder_path, ft.folder_id) as folder_path, sf.size
         FROM scanned_files sf
         LEFT JOIN scan_queue sq ON sf.id = sq.file_id
         LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
         LEFT JOIN photo_metadata pm ON sf.id = pm.file_id
         LEFT JOIN faces_v2 fv ON sf.id = fv.file_id
         WHERE sf.md5 IS NULL
         AND sf.extension IN ('jpg','jpeg','heic')
         AND sf.size > 500000
         AND fv.id IS NULL
         AND COALESCE(sq.folder_path, ft.folder_id) IS NOT NULL
         ${cameraFilter}
         ${dateFilter}
         LIMIT ${Math.min(limit * 2, 500)}`
      );

      let md5Computed = 0;
      let md5Errors = 0;
      for (const row of noMd5) {
        const folderPath = (row.folder_path || '').replace(/[\\\/]$/, '');
        const fullPath = folderPath ? folderPath + '\\' + row.name : row.name;
        try {
          const buf = await fsAsync.readFile(fullPath);
          const md5 = crypto.createHash('md5').update(buf).digest('hex');
          await dbManager.connection.execute('UPDATE scanned_files SET md5 = ? WHERE id = ?', [md5, row.id]);
          md5Computed++;
        } catch (e) {
          md5Errors++;
          if (md5Errors <= 5) console.log(chalk.red(`  ⚠️  MD5 read failed: ${row.name} — ${e.message}`));
        }
      }
      console.log(chalk.gray(`  Computed md5 for ${md5Computed} files${md5Errors > 0 ? ` (${md5Errors} errors)` : ''}`));

      // Get pending images (not yet in faces_v2) — use scan_queue for full paths
      const sortMap = {
        'newest': 'sf.id DESC',
        'oldest': 'sf.id ASC',
        'largest': 'sf.size DESC',
        'smallest': 'sf.size ASC'
      };
      const orderBy = sortMap[options.sort] || 'sf.id DESC';

      const [pending] = await dbManager.connection.execute(
        `SELECT sf.id as file_id, sf.name as file_name, sf.size, sf.md5,
                COALESCE(sq.folder_path, ft.folder_id) as folder_path
         FROM scanned_files sf
         LEFT JOIN scan_queue sq ON sf.id = sq.file_id
         LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
         LEFT JOIN photo_metadata pm ON sf.id = pm.file_id
         LEFT JOIN faces_v2 fv ON sf.id = fv.file_id
         WHERE sf.extension IN ('jpg','jpeg','heic')
         AND sf.size > 500000
         AND fv.id IS NULL
         AND COALESCE(sq.folder_path, ft.folder_id) IS NOT NULL
         ${cameraFilter}
         ${dateFilter}
         ORDER BY ${orderBy}
         LIMIT ${limit}`
      );

      // Dedup by md5: skip files whose md5 already has faces
      const md5Seen = new Set();
      const toProcess = [];
      let dedupSkipped = 0;

      for (const row of pending) {
        if (row.md5 && md5Seen.has(row.md5)) {
          dedupSkipped++;
          continue;
        }
        if (row.md5) md5Seen.add(row.md5);

        const folderPath = (row.folder_path || '').replace(/[\\\/]$/, '');
        const fullPath = folderPath ? folderPath + '\\' + row.file_name : row.file_name;
        toProcess.push({
          fileId: row.file_id,
          filePath: fullPath,
          name: row.file_name,
          md5: row.md5
        });
      }

      console.log(chalk.gray(`  📋 Pending query returned ${pending.length} rows`));
      console.log(chalk.gray(`  📋 After dedup: ${toProcess.length} to process, ${dedupSkipped} skipped`));
      if (toProcess.length > 0) {
        console.log(chalk.gray(`  📂 Sample paths:`));
        toProcess.slice(0, 3).forEach(p => console.log(chalk.gray(`    ${p.fileId}: ${p.filePath}`)));
      }

      spinner.text = `Loaded ${toProcess.length} images (${dedupSkipped} dedup-skipped)`;

      if (toProcess.length === 0) {
        spinner.warn('No new images to scan');
        await closeDatabase();
        return;
      }

      // Load named groups for auto-matching
      let namedGroups = [];
      if (options.match) {
        namedGroups = await detector.loadNamedGroups(dbManager);
        if (namedGroups.length > 0) {
          console.log(chalk.gray(`  📋 ${namedGroups.length} named groups loaded`));
        }
      }

      // Split into chunks for parallel workers
      const chunkSize = Math.ceil(toProcess.length / numThreads);
      const chunks = [];
      for (let i = 0; i < toProcess.length; i += chunkSize) {
        chunks.push(toProcess.slice(i, i + chunkSize));
      }

      const WORKER_SCRIPT = pathMod.default.join(__dirname, '..', 'scripts', 'face-worker.js');
      const { Worker } = await import('worker_threads');

      spinner.text = `Scanning ${toProcess.length} images with ${numThreads} threads...`;
      console.log(chalk.gray(`\n  📂 First file: ${toProcess[0]?.filePath || 'N/A'}`));
      if (toProcess[0]) {
        try {
          const st = await fsAsync.stat(toProcess[0].filePath);
          console.log(chalk.gray(`  📏 First file size: ${(st.size / 1024).toFixed(0)}KB`));
        } catch (e) {
          console.log(chalk.red(`  ⚠️  First file NOT FOUND: ${toProcess[0].filePath}`));
        }
      }

      // Track stats across all workers
      let totalFaces = 0;
      let filesWithFaces = 0;
      let scanned = 0;
      let savedCount = 0;
      let matchCount = 0;
      let workersDone = 0;

      const workers = chunks.map((chunk, idx) => {
        return new Promise((resolve, reject) => {
          const worker = new Worker(WORKER_SCRIPT, {
            workerData: { items: chunk, minConfidence: minConf, model: 'antelopev2' }
          });
          let workerFaces = 0;
          let workerErrors = 0;
          let workerFiles = 0;
          let workerSkipped = 0;
          worker.on('message', async (msg) => {
            if (msg.type === 'progress') {
              workerFiles = msg.current;
              if (msg.error) {
                workerErrors++;
                console.log(chalk.red(`    [W${idx}] ✗ ${msg.name}: ${msg.error} (${msg.elapsed}ms)`));
              } else {
                workerFaces += msg.faces;
                workerSkipped += (msg.lowConf || 0);
                const faceInfo = msg.faces > 0 ? chalk.green(` → ${msg.faces} face(s)`) : chalk.gray(' → 0 faces');
                const lowConfInfo = msg.lowConf > 0 ? chalk.yellow(` (${msg.lowConf} skipped <${minConf})`) : '';
                console.log(chalk.gray(`    [W${idx}] [${msg.current}/${msg.total}] ${msg.name}${faceInfo}${lowConfInfo} (${msg.elapsed}ms, ${msg.model || '?'})`));
                if (msg.faceDetails?.length > 0) {
                  msg.faceDetails.forEach((f, fi) => {
                    const qTag = f.quality ? `q=${f.quality.toFixed(2)}` : 'q=?';
                    console.log(chalk.gray(`           face[${fi}]: conf=${(f.conf * 100).toFixed(0)}% gender=${f.gender} age=${f.age} ${qTag}`));
                  });
                }
              }
            }
            if (msg.type === 'result') {
              // Save to DB immediately when result arrives
              const result = msg.result;
              scanned++;
              const faceCount = result.faces?.length || 0;
              totalFaces += faceCount;
              if (faceCount > 0) filesWithFaces++;

              if (result.success && faceCount > 0) {
                try {
                  await dbManager.storeFacesV2(result.fileId, { ...result, model: 'antelopev2' });
                  savedCount++;
                } catch (e) {
                  console.log(chalk.red(`    💾 Save FAILED: ${e.message}`));
                }

                // Auto-match if enabled
                if (options.match && namedGroups.length > 0) {
                  for (let fi = 0; fi < result.faces.length; fi++) {
                    const face = result.faces[fi];
                    if (face.confidence < minConf) continue;
                    const { groupId, score } = detector.findMatchingGroup(face, namedGroups);
                    if (groupId) {
                      const faceIdx = face.index ?? fi;
                      try {
                        await dbManager.connection.execute(
                          'UPDATE faces_v2 SET suggested_group_id = ?, match_source = ?, match_confidence = ?, match_reviewed = 0 WHERE file_id = ? AND face_index = ?',
                          [groupId, 'auto', score, result.fileId, faceIdx]
                        );
                        matchCount++;
                      } catch {}
                    }
                  }
                }
              }
            }
            if (msg.type === 'done') {
              workersDone++;
              console.log(chalk.gray(`    [W${idx}] Done: ${workerFiles} files, ${workerFaces} faces, ${workerErrors} errors, ${workerSkipped} low-conf skipped (${msg.totalElapsed || 0}ms)`));
              if (workersDone === chunks.length) resolve();
            }
          });
          worker.on('error', (err) => {
            console.error(chalk.red(`    [W${idx}] Worker error: ${err.message}`));
            reject(err);
          });
        });
      });

      await Promise.all(workers);

      spinner.succeed('Scan complete!');
      console.log(chalk.cyan(`\n  ═══ SCAN SUMMARY ═══`));
      console.log(chalk.green(`  ✅ Faces detected:  ${totalFaces}`));
      console.log(chalk.gray(`  📸 Files scanned:   ${scanned}`));
      console.log(chalk.gray(`  🖼️  Files w/ faces:  ${filesWithFaces}`));
      console.log(chalk.gray(`  🚫 Files w/o faces: ${scanned - filesWithFaces}`));
      if (dedupSkipped > 0) {
        console.log(chalk.gray(`  ⏭️  Dedup skipped:   ${dedupSkipped}`));
      }

      const [fc] = await dbManager.connection.execute('SELECT COUNT(*) as c FROM faces_v2');
      const [fByModel] = await dbManager.connection.execute('SELECT model, COUNT(*) as c FROM faces_v2 GROUP BY model');
      const [fByStatus] = await dbManager.connection.execute('SELECT status, COUNT(*) as c FROM faces_v2 GROUP BY status');
      const [fMatched] = await dbManager.connection.execute('SELECT COUNT(*) as c FROM faces_v2 WHERE suggested_group_id IS NOT NULL');
      console.log(chalk.gray(`  💾 faces_v2 total:  ${fc[0].c} rows`));
      console.log(chalk.gray(`  🤖 By model: ${fByModel.map(r => `${r.model || '?'}=${r.c}`).join(', ') || 'none'}`));
      console.log(chalk.gray(`  📊 By status: ${fByStatus.map(r => `${r.status}=${r.c}`).join(', ') || 'none'}`));
      console.log(chalk.gray(`  🎯 Auto-matched:    ${fMatched[0].c}`));
      console.log(chalk.cyan(`  ══════════════════════\n`));

      await closeDatabase();
      process.exit(0);
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
      process.exit(1);
    }
  });

program.parse();
