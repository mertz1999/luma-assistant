SHELL := /bin/bash

PORT ?= $(shell awk -F= '/^PORT=/{print $$2}' .env 2>/dev/null | tail -n 1)
PORT := $(if $(PORT),$(PORT),8787)

WEB_PORT ?= $(shell awk -F= '/^WEB_ORIGIN=/{print $$2}' .env 2>/dev/null | head -n 1 | awk -F: '{print $$NF}' | tr -cd '0-9')
WEB_PORT := $(if $(WEB_PORT),$(WEB_PORT),5173)

PROJECT_PORTS := $(PORT) $(WEB_PORT)

.PHONY: help install install-if-needed kill-ports run

help:
	@echo "Available targets:"
	@echo "  make install           - install dependencies"
	@echo "  make install-if-needed - install dependencies only when node_modules is missing"
	@echo "  make kill-ports        - kill processes listening on project ports ($(PROJECT_PORTS))"
	@echo "  make run               - install-if-needed, kill ports, then start dev mode"

install:
	npm install --no-audit --no-fund

install-if-needed:
	@if [ ! -d node_modules ]; then \
		echo "node_modules not found. Installing dependencies..."; \
		npm install --no-audit --no-fund; \
	else \
		echo "Dependencies already installed. Skipping npm install."; \
	fi

kill-ports:
	@for p in $(PROJECT_PORTS); do \
		if [ -z "$$p" ]; then continue; fi; \
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

run: install-if-needed kill-ports
	npm run dev
