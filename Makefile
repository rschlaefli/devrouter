ROOT := $(shell pwd)

.PHONY: build install uninstall

build:
	pnpm build

install: build
	./scripts/install-local.sh

uninstall:
	./scripts/uninstall-local.sh
