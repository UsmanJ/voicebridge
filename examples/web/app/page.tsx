import { VoiceDemoClient } from '../src/components/VoiceDemoClient';

// Static page: no data fetching, no server-side session creation. A conversation only starts when
// the user clicks Start Conversation in the browser.
export default function Page() {
  return <VoiceDemoClient />;
}
