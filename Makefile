ROOT := $(shell pwd)

.PHONY: setup build install uninstall

setup:
	pnpm install
	pnpm build
	./scripts/install-local.sh

build:
	pnpm build

install: build
	./scripts/install-local.sh

uninstall:
	./scripts/uninstall-local.sh
