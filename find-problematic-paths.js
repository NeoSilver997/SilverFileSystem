import { DatabaseManager } from './lib/database.js';
import dotenv from 'dotenv';

dotenv.config();

async function findProblematicPaths() {
  const db = new DatabaseManager();
  
  try {
    console.log('🔌 Connecting to database...');
    await db.connect();
    
    // Check for paths that might cause issues
    console.log('🔍 Looking for potentially problematic paths...');
    
    // 1. Very long paths
    const [longPaths] = await db.connection.execute(
      'SELECT id, path, LENGTH(path) as path_length FROM scanned_files WHERE folder_id IS NULL AND LENGTH(path) > 500 LIMIT 5'
    );
    
    console.log(`📏 Found ${longPaths.length} very long paths (>500 chars):`);
    for (const file of longPaths) {
      console.log(`  ${file.path_length} chars: ${file.path.substring(0, 100)}...`);
    }
    
    // 2. Paths with special characters
    const [specialChars] = await db.connection.execute(
      "SELECT id, path FROM scanned_files WHERE folder_id IS NULL AND path REGEXP '[^A-Za-z0-9:/\\\\._-]' LIMIT 5"
    );
    
    console.log(`\n🔤 Found ${specialChars.length} paths with special characters:`);
    for (const file of specialChars) {
      console.log(`  ${file.path}`);
    }
    
    // 3. Paths with quotes or unusual characters
    const [quotes] = await db.connection.execute(
      "SELECT id, path FROM scanned_files WHERE folder_id IS NULL AND (path LIKE '%\\'%' OR path LIKE '%\"%') LIMIT 5"
    );
    
    console.log(`\n💬 Found ${quotes.length} paths with quotes:`);
    for (const file of quotes) {
      console.log(`  ${file.path}`);
    }
    
    // 4. Try to process one "normal" file first
    const [normalFiles] = await db.connection.execute(
      "SELECT id, path FROM scanned_files WHERE folder_id IS NULL AND path REGEXP '^[A-Za-z]:[/\\\\][A-Za-z0-9/\\\\._-]+$' LIMIT 3"
    );
    
    console.log(`\n✅ Testing with ${normalFiles.length} "normal" paths:`);
    for (const file of normalFiles) {
      try {
        console.log(`  🔍 Testing: ${file.path}`);
        const folderId = await db.findOrCreateFolder(file.path);
        console.log(`  ✅ Success - Folder ID: ${folderId}`);
        
        // Try the update
        await db.connection.execute(
          'UPDATE scanned_files SET folder_id = ? WHERE id = ?',
          [folderId, file.id]
        );
        console.log(`  ✅ File updated successfully`);
        
      } catch (error) {
        console.error(`  ❌ Error: ${error.message}`);
        console.error(`  ❌ Code: ${error.code}`);
        console.error(`  ❌ SQL State: ${error.sqlState}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Analysis failed:', error.message);
  } finally {
    await db.close();
  }
}

findProblematicPaths();