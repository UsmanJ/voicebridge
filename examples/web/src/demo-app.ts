/**
 * Display copy for the connected example application. This is the only application-specific file
 * in the web client: to point the demo at another backend, change these strings (and the host and
 * worker configuration). There are no answers here. Every reply comes from the backend.
 */
export interface DemoApplication {
  name: string;
  description: string;
  /** Sent to the backend verbatim when clicked, exactly as if the user had typed them. */
  examplePrompts: readonly string[];
}

export const DEMO_APPLICATION: DemoApplication = {
  name: 'Pebblebrook Home Goods',
  description:
    'A fictional retailer’s help desk. Answers come from its existing backend over the VoiceBridge ' +
    'wire contract and are spoken verbatim. No LLM is involved.',
  examplePrompts: [
    'What are your opening hours?',
    'What is your returns policy?',
    'How long does delivery take?',
  ],
};
