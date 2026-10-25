FROM ghcr.io/astral-sh/uv:0.9.4 AS uv
FROM python:3.13.8-slim
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY app.py ./
USER 65532:65532
EXPOSE 8080
CMD [".venv/bin/python", "app.py"]
