#!/usr/bin/env node

import { DatabaseManager, loadConfig } from './index.js';

async function testDatabaseConnection() {
  console.log('Testing database connection...\n');
  
  try {
    // Load configuration
    const config = loadConfig();
    console.log('Configuration loaded:');
    console.log(`  Host: ${config.database.host}`);
    console.log(`  Port: ${config.database.port}`);
    console.log(`  User: ${config.database.user}`);
    console.log(`  Database: ${config.database.database}`);
    console.log('');
    
    // Test connection
    const db = new DatabaseManager(config.database);
    await db.connect();
    console.log('✅ Database connection successful!');
    
    // Test table initialization
    await db.initializeTables();
    console.log('✅ Database tables initialized successfully!');
    
    // Test basic operations
    const stats = await db.getStatistics();
    console.log(`✅ Database query successful! Found ${stats.total_files || 0} files`);
    
    await db.close();
    console.log('✅ Database connection closed cleanly');
    
    console.log('\n🎉 All database tests passed!');
    
  } catch (error) {
    console.error('❌ Database test failed:', error.message);
    console.error('\nTroubleshooting tips:');
    console.error('1. Make sure MySQL server is running');
    console.error('2. Verify database credentials in config.json');
    console.error('3. Ensure the database "silverfilesystem" exists');
    console.error('4. Check that user has proper permissions');
    process.exit(1);
  }
}

testDatabaseConnection();