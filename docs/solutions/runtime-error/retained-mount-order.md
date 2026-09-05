# Docker mount ordering caused false retained-container drift

Status: fixed in source; live rollout requires publication and scoped recovery.

After the Compose environment-hash correction, canonical stop rejected an
unchanged retained container with an identity/quiescence error. Repeated
read-only Docker inspection returned identical mount fields, labels and running
state, but the primary container's mount array changed order.

The stop guard serialized that array directly. It now sorts serialized validated
mounts before comparing identity. Type, source and destination still participate;
no container adoption, missing-resource fallback or guard relaxation is added.

Regression tests accept repeated mount reordering and reject each changed mount
field before residual services are stopped. Existing population, ownership and
quiescence tests remain in force.
