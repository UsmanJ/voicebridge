/**
 * Version of the language-neutral wire contract between VoiceBridge and application backends.
 *
 * `0` means **experimental**: the contract may change without notice until it has been validated
 * against the example applications. Sent as the `VoiceBridge-Version` header and used in paths
 * (`/v0/...`).
 */
export const WIRE_PROTOCOL_VERSION = '0' as const;

/**
 * Version of the TypeScript runtime port ({@link RuntimeSession} and friends).
 *
 * `0.x` means **unstable**. It will change when a second real runtime adapter is built.
 */
export const RUNTIME_PORT_VERSION = '0.1.0' as const;
