# Snapshot fence accepted a reused inode number

Status: source correction verified on draft PR #121; publication and release pending.

`CapacityStore` fenced a replacement snapshot with `dev:ino`, the identity of the
file it read last, so a caller that had already read one revision could still
mutate a store whose snapshot had been deleted and recreated when the filesystem
reused the inode number. CI reproduced the reuse twice: the loaded dispatch run
at `7467786` on PR #121 and the docs-only run at `c281acc` on PR #120 both failed
`fences a replacement that reuses the revision a caller already read` with
expected function to throw an error, but it didn't, while the ordinary push run
at the same source revision passed.

Identity now carries a SHA-256 digest of the exact snapshot bytes next to the
device and inode, so a replacement is fenced by what the snapshot contains. The
new regression rewrites the snapshot in place under the revision the caller
already read — the deterministic form of the same reuse — and fails against the
inode-only identity.

Inode numbers, sizes, timestamps and other filesystem metadata are reusable
evidence, not identity, wherever a durable fence must separate generations.
Prefer a content digest when the value is already in memory, and keep the inode
as a secondary signal instead of the whole answer.
