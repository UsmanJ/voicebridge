/**
 * @voicebridge/core/testing: test doubles and conformance data for adapter and backend authors.
 * No vendor dependencies.
 */
export {
  ALL_CAPABILITIES,
  FakeRuntime,
  type FakeRuntimeOptions,
  type FakeSpeech,
} from './fake-runtime.ts';
export {
  type InMemoryConversation,
  type InMemoryConversationOptions,
  type RecordedCall,
  deferred,
  inMemoryConversation,
  neverUntilAborted,
} from './in-memory.ts';
export {
  CONFORMANCE_V0_PATH,
  type ConformanceVector,
  type ConformanceVectorFile,
  loadConformanceVectorsV0,
} from './vectors.ts';
