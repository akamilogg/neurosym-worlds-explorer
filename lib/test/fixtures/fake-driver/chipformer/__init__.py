"""A stand-in for Qwenputer's chipformer, for the harness's tests only: the contracts the junior's worker, verifier and
trainer rely on (chipformer.rv.store, bridge, chat), with no model. Its store keeps what its tools are given, keyed as
the real one keys them; its circuit prints its answers into the stream."""
