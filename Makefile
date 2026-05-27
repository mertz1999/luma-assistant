SHELL := /bin/bash

API_PORT ?= $(shell awk -F= '/^API_PORT=/{print $$2}' .env 2>/dev/null | tail -n 1)
API_PORT := $(if $(API_PORT),$(API_PORT),9001)

WEB_PORT ?= $(shell awk -F= '/^WEB_PORT=/{print $$2}' .env 2>/dev/null | tail -n 1)
WEB_PORT := $(if $(WEB_PORT),$(WEB_PORT),5175)

TELEGRAM_MCP_PORT ?= $(shell awk -F= '/^TELEGRAM_MCP_PORT=/{print $$2}' .env 2>/dev/null | tail -n 1)
TELEGRAM_MCP_PORT := $(if $(TELEGRAM_MCP_PORT),$(TELEGRAM_MCP_PORT),9013)

PROJECT_PORTS := $(API_PORT) $(WEB_PORT) $(TELEGRAM_MCP_PORT)
PM2_BIN := npx pm2
PM2_ECOSYSTEM := scripts/pm2/ecosystem.config.cjs

.PHONY: install install-if-needed install-pm2 stop-dev-processes kill-ports stop-pm2-apps ensure-telegram-mcp run deploy-start deploy-stop deploy-status deploy-logs

install:
	npm install --include=optional --no-audit --no-fund

install-if-needed:
	@if [ ! -d node_modules ]; then \
		echo "node_modules missing; installing dependencies..."; \
		npm install --include=optional --no-audit --no-fund; \
		elif ! node -e "try{require.resolve('node-pty/package.json');process.exit(0)}catch{process.exit(1)}"; then \
			echo "node-pty missing; reinstalling dependencies..."; \
			npm install --include=optional --no-audit --no-fund; \
		elif ! node -e "try{require.resolve('@modelcontextprotocol/sdk/package.json');process.exit(0)}catch{process.exit(1)}"; then \
			echo "Telegram MCP dependencies missing; reinstalling dependencies..."; \
			npm install --include=optional --no-audit --no-fund; \
		elif ! node -e "const m={'darwin-arm64':'@esbuild/darwin-arm64','darwin-x64':'@esbuild/darwin-x64','linux-arm':'@esbuild/linux-arm','linux-arm64':'@esbuild/linux-arm64','linux-ia32':'@esbuild/linux-ia32','linux-loong64':'@esbuild/linux-loong64','linux-mips64el':'@esbuild/linux-mips64el','linux-ppc64':'@esbuild/linux-ppc64','linux-riscv64':'@esbuild/linux-riscv64','linux-s390x':'@esbuild/linux-s390x','linux-x64':'@esbuild/linux-x64','freebsd-arm64':'@esbuild/freebsd-arm64','freebsd-x64':'@esbuild/freebsd-x64','netbsd-arm64':'@esbuild/netbsd-arm64','netbsd-x64':'@esbuild/netbsd-x64','openbsd-arm64':'@esbuild/openbsd-arm64','openbsd-x64':'@esbuild/openbsd-x64','sunos-x64':'@esbuild/sunos-x64','win32-arm64':'@esbuild/win32-arm64','win32-ia32':'@esbuild/win32-ia32','win32-x64':'@esbuild/win32-x64','android-arm':'@esbuild/android-arm','android-arm64':'@esbuild/android-arm64','android-x64':'@esbuild/android-x64','aix-ppc64':'@esbuild/aix-ppc64'}; const key=process.platform+'-'+process.arch; const pkg=m[key]; if(!pkg) process.exit(0); try{require.resolve(pkg+'/package.json'); process.exit(0);} catch{process.exit(1);}"; then \
		echo "esbuild optional binary missing; reinstalling dependencies..."; \
		npm install --include=optional --no-audit --no-fund; \
		PKG=$$(node -e "const m={'darwin-arm64':'@esbuild/darwin-arm64','darwin-x64':'@esbuild/darwin-x64','linux-arm':'@esbuild/linux-arm','linux-arm64':'@esbuild/linux-arm64','linux-ia32':'@esbuild/linux-ia32','linux-loong64':'@esbuild/linux-loong64','linux-mips64el':'@esbuild/linux-mips64el','linux-ppc64':'@esbuild/linux-ppc64','linux-riscv64':'@esbuild/linux-riscv64','linux-s390x':'@esbuild/linux-s390x','linux-x64':'@esbuild/linux-x64','freebsd-arm64':'@esbuild/freebsd-arm64','freebsd-x64':'@esbuild/freebsd-x64','netbsd-arm64':'@esbuild/netbsd-arm64','netbsd-x64':'@esbuild/netbsd-x64','openbsd-arm64':'@esbuild/openbsd-arm64','openbsd-x64':'@esbuild/openbsd-x64','sunos-x64':'@esbuild/sunos-x64','win32-arm64':'@esbuild/win32-arm64','win32-ia32':'@esbuild/win32-ia32','win32-x64':'@esbuild/win32-x64','android-arm':'@esbuild/android-arm','android-arm64':'@esbuild/android-arm64','android-x64':'@esbuild/android-x64','aix-ppc64':'@esbuild/aix-ppc64'}; const key=process.platform+'-'+process.arch; const pkg=m[key]; if(pkg) process.stdout.write(pkg);"); \
		VER=$$(node -e "try{process.stdout.write(require('esbuild/package.json').version)}catch{process.stdout.write('')}"); \
		if [ -n "$$PKG" ] && [ -n "$$VER" ]; then \
			npm install --no-save --include=optional --no-audit --no-fund $$PKG@$$VER; \
		fi; \
	else \
		echo "Dependencies already installed."; \
	fi

install-pm2:
	@if [ ! -x node_modules/.bin/pm2 ]; then \
		echo "Installing pm2 locally (project-scoped)..."; \
		npm install --include=optional --no-audit --no-fund; \
	else \
		echo "pm2 already available in node_modules/.bin"; \
	fi

stop-pm2-apps: install-pm2
	-$(PM2_BIN) delete luma-assistant-server
	-$(PM2_BIN) delete luma-assistant-web
	-$(PM2_BIN) delete luma-telegram-mcp
	@if [ -d "$(CURDIR)/data/pm2" ]; then \
		PM2_HOME="$(CURDIR)/data/pm2" $(PM2_BIN) delete luma-assistant-server || true; \
		PM2_HOME="$(CURDIR)/data/pm2" $(PM2_BIN) delete luma-assistant-web || true; \
		PM2_HOME="$(CURDIR)/data/pm2" $(PM2_BIN) delete luma-telegram-mcp || true; \
	fi

stop-dev-processes:
	-@pkill -f "$(CURDIR)/node_modules/.bin/concurrently" 2>/dev/null || true
	-@pkill -f "$(CURDIR)/node_modules/.bin/tsx watch" 2>/dev/null || true
	-@pkill -f "$(CURDIR)/node_modules/tsx/dist/.*src/index.ts" 2>/dev/null || true

kill-ports:
	@for p in $(PROJECT_PORTS); do \
		PIDS=$$(lsof -ti tcp:$$p -sTCP:LISTEN 2>/dev/null || true); \
		if [ -n "$$PIDS" ]; then \
			echo "Killing process(es) on port $$p: $$PIDS"; \
			kill $$PIDS || true; \
			sleep 1; \
			STILL=$$(lsof -ti tcp:$$p -sTCP:LISTEN 2>/dev/null || true); \
			if [ -n "$$STILL" ]; then \
				echo "Force killing remaining process(es) on port $$p: $$STILL"; \
				kill -9 $$STILL || true; \
			fi; \
		else \
			echo "Port $$p is free."; \
		fi; \
	done

ensure-telegram-mcp:
	node scripts/ensure-telegram-mcp.cjs

run: install-if-needed ensure-telegram-mcp stop-pm2-apps stop-dev-processes kill-ports
	npm run dev

deploy-start: install-if-needed install-pm2 ensure-telegram-mcp stop-pm2-apps stop-dev-processes kill-ports
	@mkdir -p data/logs
	npm run build
	API_PORT=$(API_PORT) WEB_PORT=$(WEB_PORT) TELEGRAM_MCP_PORT=$(TELEGRAM_MCP_PORT) HOST=$(HOST) NODE_ENV=production $(PM2_BIN) startOrReload $(PM2_ECOSYSTEM) --update-env
	$(PM2_BIN) save
	$(PM2_BIN) status

deploy-stop: install-pm2 stop-pm2-apps
	-$(PM2_BIN) save
	$(PM2_BIN) status

deploy-status: install-pm2
	$(PM2_BIN) status

deploy-logs: install-pm2
	$(PM2_BIN) logs --lines 150
