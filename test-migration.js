#!/usr/bin/env node

/**
 * Test script for database migration system
 * This script demonstrates the version tracking functionality
 * 
 * Usage:
 *   node test-migration.js [--create-db]
 * 
 * Options:
 *   --create-db    Attempt to create and test with actual database
 *                  (requires MySQL running with proper credentials)
 */

import { DatabaseManager } from './lib/database.js';

const args = process.argv.slice(2);
const createDb = args.includes('--create-db');

async function demonstrateMigrationSystem() {
  console.log('=== Database Migration System Demo ===\n');

  const db = new DatabaseManager({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'silverfilesystem_test'
  });

  if (!createDb) {
    console.log('Running in demonstration mode (no database connection)');
    console.log('To test with actual database, run: node test-migration.js --create-db\n');
    
    console.log('Expected workflow:');
    console.log('1. Fresh database (version 0)');
    console.log('   → Call initializeTables()');
    console.log('   → Creates db_version table');
    console.log('   → Creates all base tables');
    console.log('   → Sets version to 1\n');
    
    console.log('2. Existing database at version 1');
    console.log('   → Call updateSchema()');
    console.log('   → Checks current version');
    console.log('   → Applies version 2 migration (duplicate tracking)');
    console.log('   → Applies version 3 migration (folder_id)');
    console.log('   → Database now at version 3\n');
    
    console.log('3. Already updated database at version 3');
    console.log('   → Call updateSchema()');
    console.log('   → Checks current version');
    console.log('   → No migrations needed');
    console.log('   → Database remains at version 3\n');
    
    console.log('Migration Methods Available:');
    console.log('✓ createVersionTable() - Creates db_version table');
    console.log('✓ getCurrentVersion() - Returns current version number');
    console.log('✓ setVersion(v, desc) - Records a migration');
    console.log('✓ isMigrationApplied(v) - Checks if version applied');
    console.log('✓ migrateToVersion2() - Adds duplicate tracking');
    console.log('✓ migrateToVersion3() - Adds folder_id column');
    console.log('✓ updateSchema() - Applies all pending migrations\n');
    
    return;
  }

  // Actual database testing
  try {
    console.log('Connecting to database...');
    await db.connect();
    console.log('✓ Connected successfully\n');

    // Test 1: Check if version table exists and get current version
    console.log('Test 1: Check current version');
    try {
      const currentVersion = await db.getCurrentVersion();
      console.log(`✓ Current database version: ${currentVersion}\n`);

      if (currentVersion === 0) {
        console.log('Test 2: Initialize tables (version 0 → 1)');
        await db.initializeTables();
        const newVersion = await db.getCurrentVersion();
        console.log(`✓ Database initialized to version ${newVersion}\n`);
      } else {
        console.log('Test 2: Database already initialized, skipping\n');
      }
    } catch (err) {
      console.log('! Version table does not exist yet');
      console.log('Test 2: Initialize tables (creates version table)');
      await db.initializeTables();
      const version = await db.getCurrentVersion();
      console.log(`✓ Database initialized to version ${version}\n`);
    }

    // Test 3: Check if migrations are applied
    console.log('Test 3: Check migration status');
    const hasV2 = await db.isMigrationApplied(2);
    const hasV3 = await db.isMigrationApplied(3);
    console.log(`✓ Version 2 applied: ${hasV2}`);
    console.log(`✓ Version 3 applied: ${hasV3}\n`);

    // Test 4: Update schema
    console.log('Test 4: Run schema updates');
    const beforeVersion = await db.getCurrentVersion();
    console.log(`  Before: version ${beforeVersion}`);
    
    await db.updateSchema();
    
    const afterVersion = await db.getCurrentVersion();
    console.log(`  After: version ${afterVersion}`);
    
    if (afterVersion > beforeVersion) {
      console.log(`✓ Schema updated from ${beforeVersion} to ${afterVersion}\n`);
    } else {
      console.log('✓ Schema already up to date\n');
    }

    // Test 5: Query version history
    console.log('Test 5: Version history');
    const [rows] = await db.connection.execute(
      'SELECT version, description, applied_at FROM db_version ORDER BY version'
    );
    
    console.log('Applied migrations:');
    rows.forEach(row => {
      const date = row.applied_at.toISOString().split('T')[0];
      console.log(`  v${row.version}: ${row.description} (${date})`);
    });
    console.log();

    console.log('=== All tests completed successfully ===');
    
    // Close connection
    await db.connection.end();
    console.log('✓ Database connection closed');

  } catch (err) {
    console.error('✗ Error:', err.message);
    console.error('\nMake sure:');
    console.error('1. MySQL is running');
    console.error('2. Database exists or user has CREATE DATABASE permission');
    console.error('3. Credentials are correct (set DB_HOST, DB_USER, DB_PASSWORD env vars)');
    process.exit(1);
  }
}

demonstrateMigrationSystem().catch(console.error);
