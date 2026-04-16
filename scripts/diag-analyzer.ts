/**
 * Diagnostic script: runs training analyzer with forceFullRun
 * and captures ALL console output to a log file.
 *
 * Usage: npx tsx scripts/diag-analyzer.ts
 * Output: scripts/diag-analyzer.log
 */

import { runTrainingAnalysis } from '../src/lib/training-data-analyzer';
import prisma from '../src/lib/prisma';
import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(__dirname, 'diag-analyzer.log');

// Intercept all console output to both stdout AND log file
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function ts() {
  return new Date().toISOString();
}

console.log = (...args: unknown[]) => {
  const line = `[${ts()}] LOG: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ')}\n`;
  logStream.write(line);
  origLog(...args);
};
console.warn = (...args: unknown[]) => {
  const line = `[${ts()}] WARN: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ')}\n`;
  logStream.write(line);
  origWarn(...args);
};
console.error = (...args: unknown[]) => {
  const line = `[${ts()}] ERROR: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ')}\n`;
  logStream.write(line);
  origError(...args);
};

async function main() {
  const accountId = 'cmnc6h63r0000l904c72g18aq';

  console.log(`=== DIAGNOSTIC ANALYZER RUN ===`);
  console.log(`Account: ${accountId}`);
  console.log(`Force full run: true`);
  console.log(`Log file: ${LOG_FILE}`);
  console.log(`Start time: ${ts()}`);
  console.log(`================================\n`);

  try {
    const startMs = Date.now();
    const result = await runTrainingAnalysis(accountId, { forceFullRun: true });
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

    console.log(`\n=== ANALYSIS COMPLETE (${elapsed}s) ===`);
    console.log(`Overall score: ${result.overallScore}`);
    console.log(
      `Category scores: ${JSON.stringify(result.categoryScores, null, 2)}`
    );
    console.log(`Total conversations: ${result.totalConversations}`);
    console.log(`Total messages: ${result.totalMessages}`);
    console.log(`Summary: ${result.summary}`);
    console.log(
      `Recommendations: ${JSON.stringify(result.recommendations, null, 2)}`
    );
    console.log(
      `Category metrics keys: ${JSON.stringify(
        Object.fromEntries(
          Object.entries(result.categoryMetrics).map(([k, v]) => [
            k,
            Object.keys(v)
          ])
        ),
        null,
        2
      )}`
    );

    // Dump full category metrics
    console.log(`\n=== FULL CATEGORY METRICS ===`);
    for (const [cat, metrics] of Object.entries(result.categoryMetrics)) {
      console.log(`\n--- ${cat} ---`);
      console.log(JSON.stringify(metrics, null, 2));
    }
  } catch (err) {
    console.error(`\n=== ANALYSIS FAILED ===`);
    console.error(err);
  } finally {
    await prisma.$disconnect();
    logStream.end();
    origLog(`\nLog written to: ${LOG_FILE}`);
  }
}

main();
