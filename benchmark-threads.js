#!/usr/bin/env node

import { performance } from 'perf_hooks';
import { spawn } from 'child_process';
import chalk from 'chalk';

const testConfigurations = [
  { threads: 4, batchSize: 50, label: '4 threads, 50 batch' },
  { threads: 6, batchSize: 50, label: '6 threads, 50 batch' },
  { threads: 8, batchSize: 50, label: '8 threads, 50 batch' },
  { threads: 8, batchSize: 100, label: '8 threads, 100 batch' },
  { threads: 10, batchSize: 100, label: '10 threads, 100 batch' },
  { threads: 12, batchSize: 100, label: '12 threads, 100 batch' }
];

const TEST_LIMIT = 200; // Test with 200 files for quick benchmarking

async function runTest(config) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    
    console.log(chalk.cyan(`\n🧪 Testing: ${config.label}`));
    
    const args = [
      'bin/cli.js',
      'extract-media-from-db',
      '--limit', TEST_LIMIT.toString(),
      '--skip-existing',
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
        // Extract processed count from output
        const match = stdout.match(/Total files processed: (\d+)/);
        const processedFiles = match ? parseInt(match[1]) : 0;
        
        // Extract extracted count
        const extractedMatch = stdout.match(/Successfully extracted: (\d+)/);
        const extractedFiles = extractedMatch ? parseInt(extractedMatch[1]) : 0;
        
        const throughput = processedFiles / duration; // files per second
        
        resolve({
          config,
          duration,
          processedFiles,
          extractedFiles,
          throughput,
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

async function runBenchmarks() {
  console.log(chalk.yellow('🚀 Starting Multi-Threading Performance Benchmark'));
  console.log(chalk.gray(`System: 12 CPU cores, 64GB RAM`));
  console.log(chalk.gray(`Test size: ${TEST_LIMIT} files per configuration\n`));
  
  const results = [];
  
  for (const config of testConfigurations) {
    try {
      const result = await runTest(config);
      results.push(result);
      
      console.log(chalk.green(`✅ ${result.config.label}`));
      console.log(chalk.white(`   Duration: ${result.duration.toFixed(2)}s`));
      console.log(chalk.white(`   Processed: ${result.processedFiles} files`));
      console.log(chalk.white(`   Extracted: ${result.extractedFiles} files`));
      console.log(chalk.white(`   Throughput: ${result.throughput.toFixed(2)} files/sec`));
      
    } catch (error) {
      console.log(chalk.red(`❌ ${error.config.label}: ${error.error}`));
    }
    
    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Analyze results
  console.log(chalk.yellow('\n📊 Performance Analysis\n'));
  
  const successfulResults = results.filter(r => r.success);
  if (successfulResults.length === 0) {
    console.log(chalk.red('No successful test runs'));
    return;
  }
  
  // Sort by throughput (files/sec)
  successfulResults.sort((a, b) => b.throughput - a.throughput);
  
  console.log(chalk.green('🏆 Rankings by Throughput (files/sec):'));
  successfulResults.forEach((result, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
    console.log(`${medal} ${index + 1}. ${result.config.label}: ${result.throughput.toFixed(2)} files/sec`);
  });
  
  // Find optimal configuration
  const fastest = successfulResults[0];
  console.log(chalk.cyan(`\n🎯 Optimal Configuration:`));
  console.log(chalk.white(`   Threads: ${fastest.config.threads}`));
  console.log(chalk.white(`   Batch Size: ${fastest.config.batchSize}`));
  console.log(chalk.white(`   Performance: ${fastest.throughput.toFixed(2)} files/sec`));
  
  // Efficiency analysis
  console.log(chalk.yellow('\n📈 Efficiency Analysis:'));
  
  const coreEfficiency = successfulResults.map(r => ({
    config: r.config.label,
    efficiency: (r.throughput / r.config.threads).toFixed(2),
    threadsPerCore: (r.config.threads / 12).toFixed(2)
  }));
  
  coreEfficiency.sort((a, b) => b.efficiency - a.efficiency);
  console.log(chalk.white('Efficiency (files/sec per thread):'));
  coreEfficiency.forEach((eff, index) => {
    console.log(`   ${index + 1}. ${eff.config}: ${eff.efficiency} files/sec/thread`);
  });
  
  // Recommendations
  console.log(chalk.green('\n💡 Recommendations:'));
  console.log(`   • For maximum speed: --threads ${fastest.config.threads} --batch-size ${fastest.config.batchSize}`);
  
  const mostEfficient = coreEfficiency[0];
  console.log(`   • For efficiency: ${mostEfficient.config}`);
  
  // Sweet spot analysis
  const sweetSpot = successfulResults.find(r => 
    r.config.threads >= 6 && r.config.threads <= 10 && r.throughput >= fastest.throughput * 0.95
  );
  
  if (sweetSpot) {
    console.log(`   • Sweet spot: --threads ${sweetSpot.config.threads} --batch-size ${sweetSpot.config.batchSize} (${sweetSpot.throughput.toFixed(2)} files/sec)`);
  }
}

runBenchmarks().catch(console.error);