# Contributing to devrouter

Thank you for your interest in contributing to `devrouter`! Here are some guidelines to help you get started.

## Code of Conduct

Please note that this project is released with a Contributor Code of Conduct. By participating in this project, you agree to abide by its terms.

## Development Workflow

1. **Clone the repository:**
   ```bash
   git clone https://github.com/rschlaefli/devrouter.git
   cd devrouter
   ```

2. **Install dependencies:**
   This project uses `pnpm` for package management.
   ```bash
   pnpm install
   ```

3. **Build the CLI:**
   ```bash
   pnpm build
   ```

4. **Run tests:**
   To run the test suite:
   ```bash
   pnpm test
   ```

5. **Typecheck & Lint:**
   ```bash
   pnpm typecheck
   pnpm check:docs-policy
   ```

6. **Submit a Pull Request:**
   - Keep pull requests focused on a single change.
   - Ensure all tests pass and that there are no type-checking or documentation policy errors.
   - Format code using standard formatters prior to submitting.
