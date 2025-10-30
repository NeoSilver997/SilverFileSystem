# Enhanced Logging for Media Extraction

## Overview

Added comprehensive logging features to track skipped files, errors, and detailed processing information during multi-threaded media metadata extraction.

## New Features

### 1. Detailed Skip Tracking
- **File Accessibility**: Tracks files that cannot be accessed (permissions, missing files)
- **Metadata Extraction**: Logs files where metadata extraction failed
- **Unsupported Formats**: Identifies files with unsupported formats
- **Detailed Reasons**: Provides specific reasons for each skip

### 2. Enhanced Error Logging
- **File-Level Errors**: Individual error tracking per file
- **Error Context**: Full file path and error details
- **Stack Traces**: Optional stack trace logging for development
- **Error Categorization**: Different error types tracked separately

### 3. Progress Reporting
- **Real-Time Stats**: Live updates during processing
- **Batch Summaries**: Progress per batch group
- **Success Rates**: Percentage calculations
- **Performance Metrics**: Throughput and efficiency stats

### 4. Log File Support
- **Persistent Logging**: Save detailed logs to file
- **Structured Format**: Timestamp and categorized entries
- **Summary Reports**: Final statistics in log file
- **Large Batch Support**: Handle massive processing runs

## Command Options

### New CLI Parameters
```bash
--verbose              # Show detailed console output
--log-file <path>      # Save logs to specified file
```

### Usage Examples

#### Basic Processing with Console Logs
```bash
node bin/cli.js extract-media-from-db --limit 1000 --threads 4
```

#### Verbose Mode with Detailed Console Output
```bash
node bin/cli.js extract-media-from-db --limit 1000 --threads 4 --verbose
```

#### Large Batch with Log File
```bash
node bin/cli.js extract-media-from-db --limit 20000 --threads 8 --log-file extraction.log
```

#### Full Debugging with Both
```bash
node bin/cli.js extract-media-from-db --limit 1000 --threads 4 --verbose --log-file debug.log
```

## Log Output Examples

### Console Output (Non-Verbose)
```
Using 2 worker threads with 2 batches (10 files per batch)

✅ Completed batch group 1/1
   Extracted: 15 | Skipped: 3 | Errors: 2
   Total Progress: 15/20 extracted

📊 === Extraction Summary === 📊
📁 Total files processed: 20
✅ Successfully extracted: 15 (75.0%)
⚠️  Skipped files: 3 (15.0%)
❌ Error files: 2 (10.0%)

⚡ Performance: Used 2 worker threads processing 2 batches
📈 Throughput: 10.0 files per batch
```

### Console Output (Verbose Mode)
```
⚠️  Skipped DSC00226.JPG: No metadata extracted
   Path: D:\Photo\DCIM\100MSDCF\DSC00226.JPG
   Details: Unsupported file type or corrupt file

❌ Error processing IMG_0123.JPG:
   Path: D:\Photo\DCIM\IMG_0123.JPG
   Error: Database connection timeout
```

### Log File Format
```
Media Extraction Log - 2025-10-30T17:45:24.553Z
==================================================
2025-10-30T17:45:24.888Z - SKIP: DSC00226.JPG | Path: D:\Photo\DCIM\100MSDCF\DSC00226.JPG | Reason: No metadata extracted | Details: Unsupported file type or corrupt file
2025-10-30T17:45:24.889Z - ERROR: IMG_0123.JPG | Path: D:\Photo\DCIM\IMG_0123.JPG | Error: Database connection timeout
==================================================
2025-10-30T17:45:24.896Z - SUMMARY: Processed: 20 | Extracted: 15 | Skipped: 3 | Errors: 2
2025-10-30T17:45:24.897Z - SUCCESS_RATE: 75.0%
```

## Skip Categories Tracked

### 1. File Access Issues
- **File Not Found**: File was moved or deleted
- **Permission Denied**: Insufficient access rights
- **Network Issues**: Network drive unavailable

### 2. Format Issues
- **Unsupported Format**: File type not supported by extractors
- **Corrupt Files**: Damaged or incomplete files
- **Empty Files**: Zero-byte or header-only files

### 3. Processing Issues
- **Metadata Missing**: File has no extractable metadata
- **Extraction Failed**: Technical extraction errors
- **Database Issues**: Storage problems

## Error Categories Tracked

### 1. System Errors
- **File System**: Access, permission, or I/O errors
- **Memory**: Out of memory or resource exhaustion
- **Network**: Connection or timeout issues

### 2. Processing Errors
- **Format Errors**: Parsing or decoding failures
- **Validation Errors**: Invalid or malformed data
- **Transform Errors**: Data conversion issues

### 3. Database Errors
- **Connection**: Database connectivity problems
- **Query**: SQL execution failures
- **Constraint**: Data validation or constraint violations

## Performance Insights

### Smart Alerting
- **High Skip Rate**: Warns when >10% files are skipped
- **High Error Rate**: Alerts when >5% files have errors
- **Performance Tips**: Suggests optimization based on results

### Throughput Metrics
- **Files per Batch**: Processing efficiency
- **Success Percentage**: Overall extraction success
- **Worker Utilization**: Thread efficiency analysis

## Troubleshooting Guide

### High Skip Rates
1. **Check File Formats**: Verify supported media types
2. **Test File Access**: Ensure files are accessible
3. **Network Drives**: Verify network connectivity
4. **File Permissions**: Check read access rights

### High Error Rates
1. **Database Health**: Check connection stability
2. **Memory Usage**: Monitor system resources
3. **File Corruption**: Scan for damaged files
4. **Network Stability**: Verify consistent connectivity

### Performance Issues
1. **Thread Count**: Adjust based on CPU cores
2. **Batch Size**: Balance memory vs throughput
3. **Database Load**: Monitor connection pool usage
4. **Disk I/O**: Check storage performance

## Integration Benefits

✅ **Audit Trail**: Complete record of processing activities  
✅ **Debugging**: Detailed error information for troubleshooting  
✅ **Monitoring**: Real-time and historical performance tracking  
✅ **Quality Assurance**: Success rate monitoring and alerting  
✅ **Compliance**: Persistent logging for enterprise requirements  

The enhanced logging system provides comprehensive visibility into media extraction operations, enabling effective monitoring, debugging, and optimization of large-scale processing jobs!