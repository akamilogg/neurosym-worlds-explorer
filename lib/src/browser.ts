/* The browser/harness entry: the world-neutral core plus the foxhounds@1 world under `foxhounds`.
   Node-only runtimes (runtime/node-vm.ts) are deliberately not part of it. */
export * from './index.ts';
export * as foxhounds from './worlds/foxhounds/index.ts';
