# Snapshot fence accepted a reused inode number

Status: source correction verified on draft PR #121; publication and release pending.

`CapacityStore` fenced a replacement snapshot with `dev:ino`, the identity of the
file it read last, so a caller that had already read one revision could still
mutate a store whose snapshot had been deleted and recreated when the filesystem
reused the inode number. CI reproduced the reuse on PR #121's loaded dispatch run
at `7467786` and repeatedly on the docs-only PR #120, whose main-based heads
carry no fence correction (`ce65d5c`, `14be44d`, `53c11df`, `a46eea7` at the time
of writing). Each failed `fences a replacement that reuses the revision a caller
already read` with expected function to throw an error, but it didn't, while
other runs at the same source revisions passed. The docs branch keeps flaking
until the correction reaches main. Six runs on this host's APFS did not
reproduce the reuse, so the corrected source adds a deterministic regression
instead of relying on the filesystem.

Identity now carries a SHA-256 digest of the exact snapshot bytes next to the
device and inode, so a replacement is fenced by what the snapshot contains. The
new regression rewrites the snapshot in place under the revision the caller
already read — the deterministic form of the same reuse — and fails against the
inode-only identity.

Inode numbers, sizes, timestamps and other filesystem metadata are reusable
evidence, not identity, wherever a durable fence must separate generations.
Prefer a content digest when the value is already in memory, and keep the inode
as a secondary signal instead of the whole answer.
