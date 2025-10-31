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
import { formatBytes, truncatePath, loadConfig } from '../lib/utils.js';
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
          errors++;
          processed++;
          spinner.text = `Processing ${processed}/${files.length} - Updated: ${updated}, Errors: ${errors} (${hashMethod})`;
          console.warn(chalk.yellow(`\nWarning: ${file.path}: ${err.message}`));
        }
      }
      
      spinner.succeed('Hash update complete!');
      
      console.log(chalk.green(`\n✓ Updated ${updated} file hashes (${hashMethod} method)`));
      if (useSmart) {
        console.log(chalk.cyan(`ℹ Smart optimization: Only hashed files with same size (potential duplicates)`));
        console.log(chalk.cyan(`  Use --no-smart to hash all files, or --stats to see optimization impact`));
      }
      if (errors > 0) {
        console.log(chalk.yellow(`⚠ ${errors} files had errors (file not found or read error)`));
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

program.parse();
