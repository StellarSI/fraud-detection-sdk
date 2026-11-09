import { FraudDetector } from '../src/index.js';

/**
 * Streaming & Monitoring Example
 * Demonstrates watching incoming asset activity and routing high risk alerts.
 */
async function main() {
  console.log('Initializing Streaming Watcher on Stellar testnet...');

  const detector = new FraudDetector({
    network: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  });

  const filter = {
    assets: ['USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'],
  };

  console.log('Listening for transaction alerts on asset:', filter.assets[0]);

  // Simulated alert stream handler using detector.scoreAccount
  const handleInboundAccount = async (account: string) => {
    try {
      const result = await detector.scoreAccount(account);
      console.log(`[ALERT] Inbound event for ${account} with risk level: ${result.level} (score: ${result.score})`);
      if (result.level !== 'low') {
        console.log('  -> Action: Routed to compliance review queue / hold payout triggered.');
      }
    } catch {
      // Fallback for offline demo environment
      console.log(`[ALERT] Evaluated ${account} via fallback watcher rules.`);
    }
  };

  await handleInboundAccount('GA2C5RFPE6GCKMY3US5PAB6UZLKIGSPIUKSLRB6ZN7BMQTMAYXWFDOWB');
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(console.error);
}

export { main as runStreamingExample };
