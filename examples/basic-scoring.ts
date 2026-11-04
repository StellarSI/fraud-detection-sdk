import { FraudDetector } from '../src/index.js';

/**
 * Basic Scoring Example
 * Demonstrates basic account risk scoring against the Stellar testnet horizon endpoint.
 */
async function main() {
  console.log('Initializing FraudDetector client on testnet...');

  const detector = new FraudDetector({
    network: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  });

  // Example testnet public key account
  const targetAccount = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGSPIUKSLRB6ZN7BMQTMAYXWFDOWB';

  try {
    console.log(`Analyzing risk score for account: ${targetAccount}...`);
    const result = await detector.scoreAccount(targetAccount);

    console.log('\n--- Risk Scoring Result ---');
    console.log('Account Score:', result.score);
    console.log('Risk Level:   ', result.level);
    console.log('Signals Count:', result.signals.length);
    console.log('Signals:      ', result.signals);
  } catch (error) {
    console.error('Scoring failed:', error instanceof Error ? error.message : error);
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(console.error);
}

export { main as runBasicScoring };
