#!/usr/bin/env node

import { performance } from 'perf_hooks';
import { spawn } from 'child_process';
import chalk from 'chalk';

const testConfigurations = [
  { threads: 4, batchSize: 25, label: '4 threads, 25 batch' },
  { threads: 6, batchSize: 50, label: '6 threads, 50 batch' },
  { threads: 8, batchSize: 50, label: '8 threads, 50 batch' },
  { threads: 10, batchSize: 50, label: '10 threads, 50 batch' },
  { threads: 12, batchSize: 50, label: '12 threads, 50 batch' },
  { threads: 20, batchSize: 50, label: '20 threads, 50 batch' },
  { threads: 30, batchSize: 50, label: '30 threads, 50 batch' }
];

const TEST_LIMIT = 1000; // Test with 100 files with actual extraction

async function runExtractionTest(config) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    
    console.log(chalk.cyan(`\n🧪 Testing: ${config.label}`));
    
    const args = [
      'bin/cli.js',
      'extract-media-from-db',
      '--limit', TEST_LIMIT.toString(),
      '--threads', config.threads.toString(),
      '--batch-size', config.batchSize.toString()
    ];
    
    const process = spawn('node', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    process.on('close', (code) => {
      const endTime = performance.now();
      const duration = (endTime - startTime) / 1000; // Convert to seconds
      
      if (code === 0) {
        // Extract metrics from output
        const processedMatch = stdout.match(/Total files processed: (\d+)/);
        const extractedMatch = stdout.match(/Successfully extracted: (\d+)/);
        const skippedMatch = stdout.match(/Skipped: (\d+)/);
        const errorsMatch = stdout.match(/Errors: (\d+)/);
        
        const processedFiles = processedMatch ? parseInt(processedMatch[1]) : 0;
        const extractedFiles = extractedMatch ? parseInt(extractedMatch[1]) : 0;
        const skippedFiles = skippedMatch ? parseInt(skippedMatch[1]) : 0;
        const errorFiles = errorsMatch ? parseInt(errorsMatch[1]) : 0;
        
        const extractionThroughput = extractedFiles / duration; // successful extractions per second
        const totalThroughput = processedFiles / duration; // total files processed per second
        
        resolve({
          config,
          duration,
          processedFiles,
          extractedFiles,
          skippedFiles,
          errorFiles,
          extractionThroughput,
          totalThroughput,
          success: true
        });
      } else {
        reject({
          config,
          error: stderr || 'Process failed',
          success: false
        });
      }
    });
    
    process.on('error', (error) => {
      reject({
        config,
        error: error.message,
        success: false
      });
    });
  });
}

async function runExtractionBenchmarks() {
  console.log(chalk.yellow('🚀 Media Extraction Performance Benchmark'));
  console.log(chalk.gray(`System: 12 CPU cores, 64GB RAM`));
  console.log(chalk.gray(`Test: ${TEST_LIMIT} files with actual metadata extraction\n`));
  
  const results = [];
  
  for (const config of testConfigurations) {
    try {
      const result = await runExtractionTest(config);
      results.push(result);
      
      console.log(chalk.green(`✅ ${result.config.label}`));
      console.log(chalk.white(`   Duration: ${result.duration.toFixed(2)}s`));
      console.log(chalk.white(`   Extracted: ${result.extractedFiles}/${result.processedFiles} files`));
      console.log(chalk.white(`   Extraction Rate: ${result.extractionThroughput.toFixed(2)} extractions/sec`));
      console.log(chalk.white(`   Total Throughput: ${result.totalThroughput.toFixed(2)} files/sec`));
      
      if (result.skippedFiles > 0) {
        console.log(chalk.gray(`   Skipped: ${result.skippedFiles}`));
      }
      if (result.errorFiles > 0) {
        console.log(chalk.red(`   Errors: ${result.errorFiles}`));
      }
      
    } catch (error) {
      console.log(chalk.red(`❌ ${error.config.label}: ${error.error}`));
    }
    
    // Delay between tests
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  // Analyze results
  console.log(chalk.yellow('\n📊 Performance Analysis\n'));
  
  const successfulResults = results.filter(r => r.success);
  if (successfulResults.length === 0) {
    console.log(chalk.red('No successful test runs'));
    return;
  }
  
  // Sort by extraction throughput (successful extractions per second)
  successfulResults.sort((a, b) => b.extractionThroughput - a.extractionThroughput);
  
  console.log(chalk.green('🏆 Rankings by Extraction Throughput (successful extractions/sec):'));
  successfulResults.forEach((result, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
    const successRate = ((result.extractedFiles / result.processedFiles) * 100).toFixed(1);
    console.log(`${medal} ${index + 1}. ${result.config.label}: ${result.extractionThroughput.toFixed(2)} extractions/sec (${successRate}% success)`);
  });
  
  // Find optimal configurations
  const fastest = successfulResults[0];
  console.log(chalk.cyan(`\n🎯 Fastest Configuration:`));
  console.log(chalk.white(`   --threads ${fastest.config.threads} --batch-size ${fastest.config.batchSize}`));
  console.log(chalk.white(`   Performance: ${fastest.extractionThroughput.toFixed(2)} extractions/sec`));
  console.log(chalk.white(`   Duration: ${fastest.duration.toFixed(2)}s for ${fastest.extractedFiles} files`));
  
  // Efficiency analysis (extractions per second per thread)
  console.log(chalk.yellow('\n📈 Thread Efficiency Analysis:'));
  const efficiencyResults = successfulResults.map(r => ({
    config: r.config,
    efficiency: r.extractionThroughput / r.config.threads,
    label: r.config.label
  })).sort((a, b) => b.efficiency - a.efficiency);
  
  efficiencyResults.forEach((eff, index) => {
    console.log(`   ${index + 1}. ${eff.label}: ${eff.efficiency.toFixed(2)} extractions/sec/thread`);
  });
  
  const mostEfficient = efficiencyResults[0];
  
  // Resource utilization analysis
  console.log(chalk.blue('\n⚙️ Resource Utilization:'));
  successfulResults.forEach(result => {
    const coreUsage = ((result.config.threads / 12) * 100).toFixed(1);
    console.log(`   ${result.config.label}: ${coreUsage}% of CPU cores`);
  });
  
  // Final recommendations
  console.log(chalk.green('\n💡 Recommendations for Your 12-Core System:'));
  console.log(`   🚀 Maximum Speed: --threads ${fastest.config.threads} --batch-size ${fastest.config.batchSize}`);
  console.log(`   ⚡ Best Efficiency: --threads ${mostEfficient.config.threads} --batch-size ${mostEfficient.config.batchSize}`);
  
  // Sweet spot (good performance with reasonable resource usage)
  const sweetSpot = successfulResults.find(r => 
    r.config.threads >= 6 && r.config.threads <= 10 && 
    r.extractionThroughput >= fastest.extractionThroughput * 0.9
  );
  
  if (sweetSpot) {
    console.log(`   🎯 Sweet Spot: --threads ${sweetSpot.config.threads} --batch-size ${sweetSpot.config.batchSize}`);
    console.log(`   (${sweetSpot.extractionThroughput.toFixed(2)} extractions/sec, ${((sweetSpot.config.threads/12)*100).toFixed(1)}% CPU usage)`);
  }
  
  // Large batch recommendations
  console.log(chalk.cyan('\n📦 For Large Batches (1000+ files):'));
  const largeBatchConfig = successfulResults.find(r => r.config.batchSize >= 50) || fastest;
  console.log(`   Recommended: --threads ${largeBatchConfig.config.threads} --batch-size 100`);
  console.log(`   (Larger batches reduce overhead for big jobs)`);
}

runExtractionBenchmarks().catch(console.error);