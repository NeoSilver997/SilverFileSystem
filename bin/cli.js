#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { FileScanner } from '../lib/scanner.js';
import { DuplicateFinder } from '../lib/duplicates.js';
import { EmptyFinder } from '../lib/empty.js';
import { LargeFilesFinder } from '../lib/large.js';
import { BrokenFilesFinder } from '../lib/broken.js';
import { formatBytes, truncatePath } from '../lib/utils.js';

const program = new Command();

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
  .action(async (paths, options) => {
    const spinner = ora('Scanning for duplicate files...').start();
    
    try {
      const scanner = new FileScanner();
      const finder = new DuplicateFinder(scanner);
      
      const minSize = parseInt(options.minSize);
      const useQuickHash = !options.quick; // Note: inverted logic - we want full hash by default
      
      const duplicates = await finder.findDuplicates(paths, { minSize, useQuickHash });
      const wastedSpace = finder.calculateWastedSpace(duplicates);
      
      spinner.succeed('Scan complete!');
      
      if (duplicates.length === 0) {
        console.log(chalk.green('\nNo duplicate files found!'));
        return;
      }
      
      console.log(chalk.yellow(`\nFound ${duplicates.length} groups of duplicate files:`));
      console.log(chalk.gray(`Wasted space: ${formatBytes(wastedSpace)}\n`));
      
      duplicates.forEach((group, index) => {
        console.log(chalk.cyan(`\nGroup ${index + 1} (${group.length} files, ${formatBytes(group[0].size)} each):`));
        group.forEach(file => {
          console.log(chalk.white(`  ${truncatePath(file.path)}`));
        });
      });
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
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
  .action(async (dirPath) => {
    const spinner = ora('Scanning directory...').start();
    
    try {
      const scanner = new FileScanner();
      const files = await scanner.scanDirectory(dirPath);
      
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
      
      if (extensions.size > 0) {
        console.log(chalk.yellow('\n=== Top File Types ===\n'));
        const sorted = Array.from(extensions.entries())
          .sort((a, b) => b[1].size - a[1].size)
          .slice(0, 10);
        
        sorted.forEach(([ext, stats]) => {
          console.log(chalk.cyan(`  ${ext}: ${stats.count} files (${formatBytes(stats.size)})`));
        });
      }
      
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program.parse();
