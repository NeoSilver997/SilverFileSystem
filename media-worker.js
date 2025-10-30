#!/usr/bin/env node

import { parentPort, workerData } from 'worker_threads';
import { DatabaseManager } from './lib/database.js';
import { MediaMetadataExtractor } from './lib/media.js';

async function processFiles() {
  const { files, dbConfig } = workerData;
  const results = {
    processed: 0,
    extracted: 0,
    skipped: 0,
    errors: 0,
    errorDetails: [],
    skippedDetails: []
  };
  
  let db = null;
  let mediaExtractor = null;
  
  try {
    // Initialize database connection
    db = new DatabaseManager(dbConfig);
    await db.connect();
    
    // Initialize media extractor
    mediaExtractor = new MediaMetadataExtractor();
    
    for (const file of files) {
      results.processed++;
      
      try {
        // Check if file still exists
        const fs = await import('fs/promises');
        try {
          await fs.access(file.path);
        } catch (err) {
          results.skipped++;
          results.skippedDetails.push({
            file: file.name,
            path: file.path,
            reason: 'File not accessible',
            error: err.code || err.message
          });
          continue;
        }
        
        // Extract metadata
        const result = await mediaExtractor.extractMetadata(file.path);
        
        if (result && result.metadata) {
          // Store metadata based on type
          if (result.type === 'photo') {
            await db.storePhotoMetadata(file.id, result.metadata);
          } else if (result.type === 'music') {
            await db.storeMusicMetadata(file.id, result.metadata);
          } else if (result.type === 'video') {
            await db.storeVideoMetadata(file.id, result.metadata);
          }
          
          results.extracted++;
        } else {
          results.skipped++;
          results.skippedDetails.push({
            file: file.name,
            path: file.path,
            reason: result ? 'No metadata extracted' : 'Metadata extraction failed',
            error: result ? 'Unsupported file type or corrupt file' : 'Extraction returned null'
          });
        }
        
        // Report progress periodically
        if (results.processed % 10 === 0) {
          parentPort.postMessage({
            type: 'progress',
            data: { 
              processed: results.processed, 
              total: files.length,
              filename: file.name 
            }
          });
        }
        
      } catch (err) {
        results.errors++;
        results.errorDetails.push({
          file: file.name,
          path: file.path,
          error: err.message,
          stack: err.stack
        });
      }
    }
    
    // Send final results
    parentPort.postMessage({
      type: 'complete',
      data: results
    });
    
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      data: { error: err.message }
    });
  } finally {
    // Cleanup
    if (mediaExtractor) {
      await mediaExtractor.cleanup();
    }
    if (db) {
      await db.close();
    }
  }
}

processFiles().catch(err => {
  parentPort.postMessage({
    type: 'error',
    data: { error: err.message }
  });
});