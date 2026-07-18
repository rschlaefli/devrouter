# ADR 0003: Serialize DevPod provider mutations machine-wide

Status: Accepted

Context: DevPod mutations accept only a machine-global workspace ID, while devrouter's existing lifecycle and ownership locks are repository-local. An ID can therefore be reassigned between an exact path check and an ID-only provider action issued by another repository.

Decision: Keep repository-local locks outermost and serialize each devrouter `up`, `stop`, and `delete` inside one machine-global lock. Re-read exact ID-plus-source ownership immediately before the provider action and prove the expected owner or absence again before releasing the global lock.

Why: This closes cross-repository races between devrouter processes without creating a global repository registry. Direct DevPod commands remain an external provider boundary and are prohibited by managed-environment guidance.
