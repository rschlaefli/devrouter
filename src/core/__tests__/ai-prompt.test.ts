import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildOnboardingPrompt } from '../ai-prompt'
import { loadRepoConfig } from '../repo-config'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devrouter-ai-prompt-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('buildOnboardingPrompt', () => {
  it('contains a canonical config skeleton that validates against parser', () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir })
    expect(prompt).toContain('devrouter.version: semantic version string')
    const skeletonMatch = prompt.match(
      /Canonical valid skeleton:\n```yaml\n([\s\S]*?)\n```/
    )
    expect(skeletonMatch).toBeTruthy()

    const skeleton = skeletonMatch?.[1]
    expect(skeleton).toContain('version: 1')

    fs.writeFileSync(
      path.join(tmpDir, '.devrouter.yml'),
      `${skeleton}\n`,
      'utf-8'
    )
    const config = loadRepoConfig(tmpDir)
    expect(config.version).toBe(1)
    expect(config.apps).toEqual([])
  })

  it('does not contain contradictory file-edit restrictions', () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir })
    expect(prompt).not.toContain('Create/update only REPO_PATH/.devrouter.yml.')
    expect(prompt).toContain('minimal related edits')
  })

  it('includes explicit tcp/tls onboarding sequence guidance', () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir })
    expect(prompt).toContain(
      'If any tcp/postgres app is configured, run `dev up` and `dev tls install` before runtime validation.'
    )
  })

  it('documents dependency-only app kind semantics', () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir })
    expect(prompt).toContain('kind: "app" | "dependency"')
    expect(prompt).toContain('kind=dependency requires runtime=docker')
    expect(prompt).toContain('kind=dependency entries are dependency-only')
  })

  it('includes secret-manager interop guidance with env mapping and probes', () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir })
    expect(prompt).toContain('Secret Manager Integration (config-based):')
    expect(prompt).toContain('secretManager.command')
    expect(prompt).toContain('Secret Manager Interop (manual fallback):')
    expect(prompt).toContain(
      'dev app exec <name> --repo <REPO_PATH> --yes --env-map DATABASE_URI=DATABASE_URL -- <command>'
    )
    expect(prompt).toContain(
      'printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL'
    )
    expect(prompt).toContain('Do not assume secret-manager precedence')
    expect(prompt).toContain(
      'Avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`'
    )
    expect(prompt).toContain(
      'env DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL}'
    )
    expect(prompt).toContain(
      'warns on risky pre-wrapper DB assignments before `run --`'
    )
  })

  it('includes Linear workflow section only when withLinear is enabled', () => {
    const withoutLinear = buildOnboardingPrompt({ repo: tmpDir })
    expect(withoutLinear).not.toContain(
      'Linear milestone workflow (enabled via --with-linear):'
    )

    const withLinear = buildOnboardingPrompt({ repo: tmpDir, withLinear: true })
    expect(withLinear).toContain(
      'Linear milestone workflow (enabled via --with-linear):'
    )
    expect(withLinear).toContain(
      'Which Linear workspace does this repository belong to?'
    )
    expect(withLinear).toContain('devrouter-linear-workflow-config:start')
    expect(withLinear).toContain(
      'set issue status at session start and at each phase transition'
    )
    expect(withLinear).toContain(
      'Post progress comments at meaningful checkpoints during implementation'
    )
    expect(withLinear).toContain(
      'Before ending a session, post a final recap comment with completed work, remaining work, risks, and next step'
    )
    expect(withLinear).toContain(
      'dev upgrade <version>'
    )
    expect(withLinear).toContain(
      'dev -V'
    )
    expect(withLinear).toContain(
      'upgrade-prompts/<version>.md'
    )
  })
})
