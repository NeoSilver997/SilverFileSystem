import { DatabaseManager } from './lib/database.js';
import dotenv from 'dotenv';
dotenv.config();

async function markDuplicates() {
  const db = new DatabaseManager();

  try {
    console.log('Connecting to database...');
    await db.connect();

    console.log('Updating database schema...');
    await db.updateSchema();

    console.log('Marking duplicate records...');
    const duplicateGroups = await db.markDuplicateRecords();

    console.log(`Successfully marked ${duplicateGroups} duplicate groups`);

    // Show some statistics
    const [stats] = await db.connection.execute(`
      SELECT
        COUNT(*) as total_files,
        SUM(CASE WHEN is_duplicate = TRUE THEN 1 ELSE 0 END) as duplicate_files,
        COUNT(DISTINCT duplicate_group_id) as duplicate_groups
      FROM scanned_files
    `);

    console.log('\nDuplicate Statistics:');
    console.log(`Total files: ${stats[0].total_files}`);
    console.log(`Duplicate files: ${stats[0].duplicate_files}`);
    console.log(`Duplicate groups: ${stats[0].duplicate_groups}`);

  } catch (error) {
    console.error('Error marking duplicates:', error);
  } finally {
    if (db.close) {
      await db.close();
    }
  }
}

markDuplicates();