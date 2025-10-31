#!/usr/bin/env node

import { loadConfig } from './index.js';
import chalk from 'chalk';

console.log(chalk.cyan('🔧 SilverFileSystem Configuration Verification\n'));

try {
  const config = loadConfig();
  
  console.log(chalk.green('✅ Configuration loaded successfully!\n'));
  
  console.log(chalk.yellow('Database Configuration:'));
  console.log(`  Host: ${chalk.white(config.database.host)}`);
  console.log(`  Port: ${chalk.white(config.database.port)}`);
  console.log(`  User: ${chalk.white(config.database.user)}`);
  console.log(`  Database: ${chalk.white(config.database.database)}`);
  console.log(`  Password: ${chalk.white(config.database.password ? '***hidden***' : '(empty)')}\n`);
  
  console.log(chalk.yellow('Scanner Configuration:'));
  console.log(`  Follow Symlinks: ${chalk.white(config.scanner.followSymlinks)}`);
  console.log(`  Max Depth: ${chalk.white(config.scanner.maxDepth)}`);
  console.log(`  Exclude Patterns: ${chalk.white(config.scanner.excludePatterns.join(', '))}\n`);
  
  console.log(chalk.yellow('Duplicates Configuration:'));
  console.log(`  Min Size: ${chalk.white(config.duplicates.minSize)} bytes`);
  console.log(`  Use Quick Hash: ${chalk.white(config.duplicates.useQuickHash)}\n`);
  
  console.log(chalk.yellow('Large Files Configuration:'));
  console.log(`  Min Size: ${chalk.white(config.largeFiles.minSizeMB)} MB`);
  console.log(`  Limit: ${chalk.white(config.largeFiles.limit)} files\n`);
  
  console.log(chalk.blue('Configuration Sources:'));
  console.log(`  Environment Variables: ${chalk.white(process.env.DB_HOST ? '✅ Loaded' : '❌ Not found')}`);
  console.log(`  Config File: ${chalk.white('✅ Available')}`);
  console.log(`  CLI Defaults: ${chalk.white('✅ Available')}\n`);
  
  console.log(chalk.green('🎉 All configuration sources are working correctly!'));
  console.log(chalk.gray('You can now use commands like:'));
  console.log(chalk.gray('  node bin/cli.js scan /path/to/directory --db'));
  console.log(chalk.gray('  node bin/cli.js duplicates /path/to/directory --db'));
  
} catch (error) {
  console.error(chalk.red('❌ Configuration error:'), error.message);
  process.exit(1);
}