#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { FileScanner } from '../lib/scanner.js';
import { DuplicateFinder } from '../lib/duplicates.js';
import { EmptyFinder } from '../lib/empty.js';
import { LargeFilesFinder } from '../lib/large.js';
import { BrokenFilesFinder } from '../lib/broken.js';
import { DatabaseManager } from '../lib/database.js';
import { formatBytes, truncatePath } from '../lib/utils.js';

const program = new Command();

// Global database manager instance
let dbManager = null;

// Helper function to initialize database if --db flag is set
async function initDatabase(options) {
  if (options.db) {
    dbManager = new DatabaseManager({
      host: options.dbHost,
      port: options.dbPort,
      user: options.dbUser,
      password: options.dbPassword,
      database: options.dbName
    });
    await dbManager.connect();
    await dbManager.initializeTables();
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
  .option('-m, --min-size <bytes>', 'Minimum file size to check (in bytes)', '0')
  .option('-q, --quick', 'Use quick hash (faster but less accurate)', false)
  .option('--db', 'Store results in MySQL database')
  .option('--db-host <host>', 'Database host', 'localhost')
  .option('--db-port <port>', 'Database port', '3306')
  .option('--db-user <user>', 'Database user', 'root')
  .option('--db-password <password>', 'Database password', '')
  .option('--db-name <name>', 'Database name', 'silverfilesystem')
  .action(async (paths, options) => {
    const spinner = ora('Scanning for duplicate files...').start();
    
    try {
      // Initialize database if requested
      const db = await initDatabase(options);
      
      const scanner = new FileScanner();
      const finder = new DuplicateFinder(scanner);
      
      const minSize = parseInt(options.minSize);
      const useQuickHash = !options.quick; // Note: inverted logic - we want full hash by default
      
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
  .option('-m, --min-size <bytes>', 'Minimum file size in MB', '100')
  .option('-l, --limit <number>', 'Maximum number of results', '50')
  .action(async (paths, options) => {
    const spinner = ora('Scanning for large files...').start();
    
    try {
      const scanner = new FileScanner();
      const finder = new LargeFilesFinder(scanner);
      
      const minSize = parseInt(options.minSize) * 1024 * 1024; // Convert MB to bytes
      const limit = parseInt(options.limit);
      
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
  .option('--db-host <host>', 'Database host', 'localhost')
  .option('--db-port <port>', 'Database port', '3306')
  .option('--db-user <user>', 'Database user', 'root')
  .option('--db-password <password>', 'Database password', '')
  .option('--db-name <name>', 'Database name', 'silverfilesystem')
  .action(async (dirPath, options) => {
    const spinner = ora('Scanning directory...').start();
    let scanId = null;
    
    try {
      // Initialize database if requested
      const db = await initDatabase(options);
      
      if (db) {
        scanId = await db.createScanSession(dirPath);
        spinner.text = 'Scanning directory and storing to database...';
      }
      
      const scanner = new FileScanner();
      const files = await scanner.scanDirectory(dirPath);
      
      // Store files in database if enabled
      if (db && files.length > 0) {
        spinner.text = 'Storing files to database...';
        const batchSize = 100;
        for (let i = 0; i < files.length; i += batchSize) {
          const batch = files.slice(i, i + batchSize);
          await db.storeFilesBatch(batch, scanId);
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
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      await closeDatabase();
      process.exit(1);
    }
  });

// Migrate folders normalization
program
  .command('migrate-folders')
  .description('Migrate existing database to use normalized folders table')
  .option('--db-host <host>', 'Database host (default: localhost)')
  .option('--db-port <port>', 'Database port (default: 3306)')
  .option('--db-user <user>', 'Database user (default: sfs)')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name (default: silverfilesystem)')
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || process.env.DB_HOST || 'localhost',
        port: parseInt(options.dbPort || process.env.DB_PORT || '3306'),
        user: options.dbUser || process.env.DB_USER || 'sfs',
        password: options.dbPassword || process.env.DB_PASSWORD,
        database: options.dbName || process.env.DB_NAME || 'silverfilesystem'
      });
      
      await db.connect();
      
      // Ensure tables are up to date
      await db.initializeTables();
      await db.updateSchema();
      
      spinner.text = 'Migrating to normalized folders structure...';
      
      const result = await db.migrateFoldersNormalization();
      
      spinner.succeed('Migration complete!');
      
      console.log(chalk.green('\n✅ Folder normalization migration completed successfully!'));
      console.log(chalk.cyan('\n📊 Migration Statistics:'));
      console.log(chalk.white(`   Folders created: ${result.foldersCreated}`));
      console.log(chalk.white(`   Files updated: ${result.filesUpdated}`));
      
      console.log(chalk.yellow('\n📁 Benefits of normalized folders:'));
      console.log(chalk.white('   • Faster duplicate folder detection'));
      console.log(chalk.white('   • Reduced storage of path redundancy'));
      console.log(chalk.white('   • Better folder hierarchy management'));
      console.log(chalk.white('   • Improved query performance'));
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Migration failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Establish folder hierarchy
program
  .command('fix-folder-parents')
  .description('Establish parent-child relationships for folders after migration')
  .option('--db-host <host>', 'Database host (default: localhost)')
  .option('--db-port <port>', 'Database port (default: 3306)')
  .option('--db-user <user>', 'Database user (default: sfs)')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name (default: silverfilesystem)')
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || process.env.DB_HOST || 'localhost',
        port: parseInt(options.dbPort || process.env.DB_PORT || '3306'),
        user: options.dbUser || process.env.DB_USER || 'sfs',
        password: options.dbPassword || process.env.DB_PASSWORD,
        database: options.dbName || process.env.DB_NAME || 'silverfilesystem'
      });
      
      await db.connect();
      
      spinner.text = 'Establishing folder parent-child relationships...';
      
      await db.establishFolderHierarchy();
      
      spinner.succeed('Folder hierarchy establishment complete!');
      
      console.log(chalk.green('\n✅ Folder parent relationships established successfully!'));
      
      console.log(chalk.yellow('\n📁 Folder hierarchy benefits:'));
      console.log(chalk.white('   • Proper parent-child folder relationships'));
      console.log(chalk.white('   • Better folder tree navigation'));
      console.log(chalk.white('   • Hierarchical folder operations'));
      console.log(chalk.white('   • Improved folder organization queries'));
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Folder hierarchy establishment failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Create missing parent folders
program
  .command('create-missing-parents')
  .description('Create missing parent folders and establish complete hierarchy')
  .option('--db-host <host>', 'Database host (default: localhost)')
  .option('--db-port <port>', 'Database port (default: 3306)')
  .option('--db-user <user>', 'Database user (default: sfs)')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name (default: silverfilesystem)')
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || process.env.DB_HOST || 'localhost',
        port: parseInt(options.dbPort || process.env.DB_PORT || '3306'),
        user: options.dbUser || process.env.DB_USER || 'sfs',
        password: options.dbPassword || process.env.DB_PASSWORD,
        database: options.dbName || process.env.DB_NAME || 'silverfilesystem'
      });
      
      await db.connect();
      
      spinner.text = 'Creating missing parent folders...';
      
      await db.createMissingParentFolders();
      
      spinner.succeed('Missing parent folder creation complete!');
      
      console.log(chalk.green('\n✅ Missing parent folders created successfully!'));
      
      console.log(chalk.yellow('\n📁 Complete hierarchy benefits:'));
      console.log(chalk.white('   • All folders now have proper parent relationships'));
      console.log(chalk.white('   • Complete folder tree navigation possible'));
      console.log(chalk.white('   • Full hierarchical folder operations'));
      console.log(chalk.white('   • Perfect folder organization structure'));
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Missing parent folder creation failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Update folder statistics command
program
  .command('update-folder-stats')
  .description('Update folder sizes and file counts based on actual files')
  .option('--db-host <host>', 'Database host (default: localhost)')
  .option('--db-port <port>', 'Database port (default: 3306)')
  .option('--db-user <user>', 'Database user (default: sfs)')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name (default: silverfilesystem)')
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || process.env.DB_HOST || 'localhost',
        port: parseInt(options.dbPort || process.env.DB_PORT || '3306'),
        user: options.dbUser || process.env.DB_USER || 'sfs',
        password: options.dbPassword || process.env.DB_PASSWORD,
        database: options.dbName || process.env.DB_NAME || 'silverfilesystem'
      });
      
      await db.connect();
      
      spinner.text = 'Calculating folder statistics...';
      
      await db.updateFolderStatistics();
      
      spinner.succeed('Folder statistics update complete!');
      
      console.log(chalk.green('\n✅ Folder statistics updated successfully!'));
      
      console.log(chalk.yellow('\n📊 Updated statistics include:'));
      console.log(chalk.white('   • File count per folder (direct files only)'));
      console.log(chalk.white('   • Total size per folder (sum of file sizes)'));
      console.log(chalk.white('   • Accurate folder-level metrics'));
      console.log(chalk.white('   • Performance-optimized calculations'));
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Folder statistics update failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Get folder statistics command
program
  .command('folder-stats')
  .description('Get folder statistics for specific paths or patterns')
  .argument('[path]', 'Folder path or pattern (supports wildcards like D:/Videos/*)')
  .option('-r, --recursive', 'Include subfolder totals in calculations')
  .option('--db-host <host>', 'Database host (default: localhost)')
  .option('--db-port <port>', 'Database port (default: 3306)')
  .option('--db-user <user>', 'Database user (default: sfs)')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name (default: silverfilesystem)')
  .action(async (path, options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || process.env.DB_HOST || 'localhost',
        port: parseInt(options.dbPort || process.env.DB_PORT || '3306'),
        user: options.dbUser || process.env.DB_USER || 'sfs',
        password: options.dbPassword || process.env.DB_PASSWORD,
        database: options.dbName || process.env.DB_NAME || 'silverfilesystem'
      });
      
      await db.connect();
      
      spinner.text = `Getting folder statistics${path ? ` for ${path}` : ''}...`;
      
      const results = await db.getFolderStatistics(path || '', options.recursive);
      
      spinner.succeed('Folder statistics retrieved!');
      
      if (results.length === 0) {
        console.log(chalk.yellow(`\n📁 No folders found${path ? ` matching pattern: ${path}` : ''}`));
      } else {
        console.log(chalk.green(`\n📊 Found ${results.length} folder(s)${path ? ` matching: ${path}` : ''}:`));
        console.log(chalk.gray('─'.repeat(80)));
        
        for (const folder of results.slice(0, 20)) { // Limit to top 20 results
          console.log(chalk.white(`📂 ${folder.full_path}`));
          console.log(chalk.cyan(`   Direct files: ${folder.file_count.toLocaleString()}`));
          console.log(chalk.cyan(`   Direct size: ${formatBytes(folder.total_size)}`));
          
          if (options.recursive && folder.recursive_file_count !== undefined) {
            console.log(chalk.magenta(`   Total files (inc. subfolders): ${folder.recursive_file_count.toLocaleString()}`));
            console.log(chalk.magenta(`   Total size (inc. subfolders): ${formatBytes(folder.recursive_total_size)}`));
          }
          
          console.log('');
        }
        
        if (results.length > 20) {
          console.log(chalk.gray(`... and ${results.length - 20} more folders`));
        }
        
        // Summary statistics
        const totalDirectFiles = results.reduce((sum, f) => sum + f.file_count, 0);
        const totalDirectSize = results.reduce((sum, f) => sum + f.total_size, 0);
        
        console.log(chalk.yellow('\n📈 Summary:'));
        console.log(chalk.white(`   Folders found: ${results.length.toLocaleString()}`));
        console.log(chalk.white(`   Total direct files: ${totalDirectFiles.toLocaleString()}`));
        console.log(chalk.white(`   Total direct size: ${formatBytes(totalDirectSize)}`));
        
        if (options.recursive) {
          const totalRecursiveFiles = results.reduce((sum, f) => sum + (f.recursive_file_count || f.file_count), 0);
          const totalRecursiveSize = results.reduce((sum, f) => sum + (f.recursive_total_size || f.total_size), 0);
          console.log(chalk.white(`   Total recursive files: ${totalRecursiveFiles.toLocaleString()}`));
          console.log(chalk.white(`   Total recursive size: ${formatBytes(totalRecursiveSize)}`));
        }
      }
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Failed to get folder statistics');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Find duplicate folders command
program
  .command('find-duplicate-folders')
  .description('Find duplicate folders by size and file count')
  .option('-m, --min-size <bytes>', 'Minimum folder size in bytes', '0')
  .option('-f, --min-files <count>', 'Minimum number of files in folder', '1')
  .option('-r, --report <file>', 'Generate HTML report file')
  .option('--db-host <host>', 'Database host (default: localhost)')
  .option('--db-port <port>', 'Database port (default: 3306)')
  .option('--db-user <user>', 'Database user (default: sfs)')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name (default: silverfilesystem)')
  .action(async (options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || process.env.DB_HOST || 'localhost',
        port: parseInt(options.dbPort || process.env.DB_PORT || '3306'),
        user: options.dbUser || process.env.DB_USER || 'sfs',
        password: options.dbPassword || process.env.DB_PASSWORD,
        database: options.dbName || process.env.DB_NAME || 'silverfilesystem'
      });
      
      await db.connect();
      
      spinner.text = 'Finding duplicate folders...';
      
      const minSize = parseInt(options.minSize) || 0;
      const minFiles = parseInt(options.minFiles) || 1;
      
      const duplicateGroups = await db.findDuplicateFolders(minSize, minFiles);
      
      if (duplicateGroups.length === 0) {
        spinner.succeed('No duplicate folders found!');
        console.log(chalk.yellow('\n📁 No duplicate folders found matching your criteria.'));
        console.log(chalk.white('Try adjusting the minimum size or file count filters.'));
      } else {
        spinner.succeed(`Found ${duplicateGroups.length} duplicate folder groups!`);
        
        // Display summary
        const totalWastedSpace = duplicateGroups.reduce((sum, group) => sum + group.wastedSpace, 0);
        const totalFolders = duplicateGroups.reduce((sum, group) => sum + group.folderCount, 0);
        
        console.log(chalk.green(`\n📊 Duplicate Folders Summary:`));
        console.log(chalk.white(`   Duplicate groups: ${duplicateGroups.length.toLocaleString()}`));
        console.log(chalk.white(`   Total folders: ${totalFolders.toLocaleString()}`));
        console.log(chalk.red(`   Wasted space: ${formatBytes(totalWastedSpace)}`));
        
        // Show top 5 groups
        console.log(chalk.yellow(`\n🔥 Top 5 Duplicate Groups (by wasted space):`));
        for (const [index, group] of duplicateGroups.slice(0, 5).entries()) {
          console.log(chalk.white(`\n${index + 1}. ${group.folderCount} folders × ${formatBytes(group.size)} each = ${formatBytes(group.wastedSpace)} wasted`));
          console.log(chalk.gray(`   File count: ${group.fileCount.toLocaleString()} files each`));
          
          for (const folder of group.folders) {
            console.log(chalk.cyan(`   📂 ${folder.full_path}`));
          }
        }
        
        if (duplicateGroups.length > 5) {
          console.log(chalk.gray(`\n... and ${duplicateGroups.length - 5} more duplicate groups`));
        }
        
        // Generate HTML report if requested
        if (options.report) {
          spinner.start('Generating HTML report...');
          const reportPath = await db.generateDuplicateFoldersReport(duplicateGroups, options.report);
          spinner.succeed(`HTML report generated: ${reportPath}`);
          
          console.log(chalk.green(`\n📄 Interactive HTML report created:`));
          console.log(chalk.white(`   File: ${options.report}`));
          console.log(chalk.white(`   Features: Search, filters, expandable groups`));
          console.log(chalk.white(`   Open in browser to explore results`));
        }
      }
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Failed to find duplicate folders');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Generate folder duplicates report command
program
  .command('generate-folder-report')
  .description('Generate HTML report for duplicate folders')
  .argument('<output>', 'Output HTML file path')
  .option('-m, --min-size <bytes>', 'Minimum folder size in bytes', '0')
  .option('-f, --min-files <count>', 'Minimum number of files in folder', '1')
  .option('--db-host <host>', 'Database host (default: localhost)')
  .option('--db-port <port>', 'Database port (default: 3306)')
  .option('--db-user <user>', 'Database user (default: sfs)')
  .option('--db-password <password>', 'Database password')
  .option('--db-name <name>', 'Database name (default: silverfilesystem)')
  .action(async (output, options) => {
    const spinner = ora('Connecting to database...').start();
    
    try {
      // Initialize database
      const db = new DatabaseManager({
        host: options.dbHost || process.env.DB_HOST || 'localhost',
        port: parseInt(options.dbPort || process.env.DB_PORT || '3306'),
        user: options.dbUser || process.env.DB_USER || 'sfs',
        password: options.dbPassword || process.env.DB_PASSWORD,
        database: options.dbName || process.env.DB_NAME || 'silverfilesystem'
      });
      
      await db.connect();
      
      spinner.text = 'Finding duplicate folders...';
      
      const minSize = parseInt(options.minSize) || 0;
      const minFiles = parseInt(options.minFiles) || 1;
      
      const duplicateGroups = await db.findDuplicateFolders(minSize, minFiles);
      
      spinner.text = 'Generating HTML report...';
      
      const reportPath = await db.generateDuplicateFoldersReport(duplicateGroups, output);
      
      spinner.succeed('Folder duplicates report generated!');
      
      const totalWastedSpace = duplicateGroups.reduce((sum, group) => sum + group.wastedSpace, 0);
      const totalFolders = duplicateGroups.reduce((sum, group) => sum + group.folderCount, 0);
      
      console.log(chalk.green(`\n✅ HTML Report Generated Successfully!`));
      console.log(chalk.white(`   📄 File: ${output}`));
      console.log(chalk.white(`   📊 Groups: ${duplicateGroups.length.toLocaleString()}`));
      console.log(chalk.white(`   📁 Folders: ${totalFolders.toLocaleString()}`));
      console.log(chalk.white(`   💾 Wasted Space: ${formatBytes(totalWastedSpace)}`));
      
      console.log(chalk.yellow(`\n🎨 Report Features:`));
      console.log(chalk.white(`   • Interactive search and filtering`));
      console.log(chalk.white(`   • Expandable folder groups`));
      console.log(chalk.white(`   • Mobile responsive design`));
      console.log(chalk.white(`   • Real-time statistics`));
      
      await db.close();
      
    } catch (err) {
      spinner.fail('Failed to generate folder report');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program.parse();
