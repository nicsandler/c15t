import { spawnSync } from 'node:child_process';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDocsWithScript } from '../src/steps/setup-docs';

vi.mock('node:child_process');
vi.mock('@actions/core');
vi.mock('@actions/github', () => ({
	context: {
		payload: {},
		repo: {
			owner: 'consentdotio',
			repo: 'c15t',
		},
	},
}));

describe('setupDocsWithScript - security mitigation', () => {
	const mockSpawnSync = vi.mocked(spawnSync);
	const mockCoreInfo = vi.mocked(core.info);

	beforeEach(() => {
		vi.clearAllMocks();
		// Set up a realistic environment with sensitive credentials
		process.env.PATH = '/usr/bin:/bin';
		process.env.HOME = '/home/runner';
		process.env.USER = 'runner';
		process.env.CI = 'true';
		process.env.NODE_ENV = 'test';
		
		// Sensitive credentials that should NOT be passed to child process
		process.env.INPUT_VERCEL_TOKEN = 'vercel_secret_token_12345';
		process.env.INPUT_GITHUB_TOKEN = 'ghp_secret_github_token_67890';
		process.env.INPUT_GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...secret...';
		process.env.INPUT_GITHUB_APP_ID = '123456';
		process.env.INPUT_GITHUB_APP_INSTALLATION_ID = '789012';
		process.env.VERCEL_TOKEN = 'another_vercel_token';
		process.env.GITHUB_TOKEN = 'another_github_token';
		process.env.NPM_TOKEN = 'npm_secret_token';
		process.env.AWS_SECRET_ACCESS_KEY = 'aws_secret_key';
		process.env.CONSENT_GIT_TOKEN = 'consent_git_token_from_env';

		// Mock successful spawn
		mockSpawnSync.mockReturnValue({
			status: 0,
			signal: null,
			output: [],
			pid: 12345,
			stdout: null,
			stderr: null,
		});
	});

	afterEach(() => {
		// Clean up environment
		delete process.env.PATH;
		delete process.env.HOME;
		delete process.env.USER;
		delete process.env.CI;
		delete process.env.NODE_ENV;
		delete process.env.INPUT_VERCEL_TOKEN;
		delete process.env.INPUT_GITHUB_TOKEN;
		delete process.env.INPUT_GITHUB_APP_PRIVATE_KEY;
		delete process.env.INPUT_GITHUB_APP_ID;
		delete process.env.INPUT_GITHUB_APP_INSTALLATION_ID;
		delete process.env.VERCEL_TOKEN;
		delete process.env.GITHUB_TOKEN;
		delete process.env.NPM_TOKEN;
		delete process.env.AWS_SECRET_ACCESS_KEY;
		delete process.env.CONSENT_GIT_TOKEN;
	});

	it('should only pass allowlisted environment variables to child process', () => {
		setupDocsWithScript();

		expect(mockSpawnSync).toHaveBeenCalledTimes(1);
		const spawnCall = mockSpawnSync.mock.calls[0];
		const env = spawnCall[2]?.env as Record<string, string>;

		// Verify safe variables are passed
		expect(env.PATH).toBe('/usr/bin:/bin');
		expect(env.HOME).toBe('/home/runner');
		expect(env.USER).toBe('runner');
		expect(env.CI).toBe('true');
		expect(env.NODE_ENV).toBe('test');
		expect(env.CONSENT_GIT_TOKEN).toBe('consent_git_token_from_env');

		// Verify sensitive credentials are NOT passed
		expect(env.INPUT_VERCEL_TOKEN).toBeUndefined();
		expect(env.INPUT_GITHUB_TOKEN).toBeUndefined();
		expect(env.INPUT_GITHUB_APP_PRIVATE_KEY).toBeUndefined();
		expect(env.INPUT_GITHUB_APP_ID).toBeUndefined();
		expect(env.INPUT_GITHUB_APP_INSTALLATION_ID).toBeUndefined();
		expect(env.VERCEL_TOKEN).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.NPM_TOKEN).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
	});

	it('should prevent credential leakage via environment spread', () => {
		setupDocsWithScript();

		const spawnCall = mockSpawnSync.mock.calls[0];
		const env = spawnCall[2]?.env as Record<string, string>;

		// Count the number of environment variables passed
		const envKeys = Object.keys(env);
		
		// Should only contain allowlisted variables + CONSENT_GIT_TOKEN
		// Maximum expected: PATH, HOME, USER, SHELL, TMPDIR, TMP, TEMP, NODE_ENV, CI, LANG, LC_ALL, LC_CTYPE, CONSENT_GIT_TOKEN
		// In practice, only those that exist in process.env will be present
		expect(envKeys.length).toBeLessThanOrEqual(13);

		// Verify no INPUT_* variables are present (except those explicitly allowed, which there are none)
		const inputVars = envKeys.filter(key => key.startsWith('INPUT_'));
		expect(inputVars).toEqual([]);
	});

	it('should use provided consentGitToken parameter over environment variable', () => {
		const customToken = 'custom_consent_token_override';
		setupDocsWithScript(customToken);

		const spawnCall = mockSpawnSync.mock.calls[0];
		const env = spawnCall[2]?.env as Record<string, string>;

		expect(env.CONSENT_GIT_TOKEN).toBe(customToken);
		expect(env.CONSENT_GIT_TOKEN).not.toBe('consent_git_token_from_env');
	});

	it('should use empty string when no consent token is available', () => {
		delete process.env.CONSENT_GIT_TOKEN;
		setupDocsWithScript();

		const spawnCall = mockSpawnSync.mock.calls[0];
		const env = spawnCall[2]?.env as Record<string, string>;

		expect(env.CONSENT_GIT_TOKEN).toBe('');
	});

	it('should skip docs setup for fork pull requests', () => {
		// Mock a fork PR scenario
		vi.mocked(github.context).payload = {
			pull_request: {
				head: {
					repo: {
						full_name: 'attacker/c15t',
					},
				},
			},
		};

		setupDocsWithScript();

		// Should not spawn the child process
		expect(mockSpawnSync).not.toHaveBeenCalled();
		expect(mockCoreInfo).toHaveBeenCalledWith('PR from fork detected: skipping docs setup');
	});

	it('should proceed with docs setup for same-repo pull requests', () => {
		// Mock a same-repo PR scenario
		vi.mocked(github.context).payload = {
			pull_request: {
				head: {
					repo: {
						full_name: 'consentdotio/c15t',
					},
				},
			},
		};

		setupDocsWithScript();

		// Should spawn the child process
		expect(mockSpawnSync).toHaveBeenCalledTimes(1);
		expect(mockCoreInfo).toHaveBeenCalledWith('Running docs setup script via pnpm tsx scripts/setup-docs.ts');
	});

	it('should proceed with docs setup when not in a pull request context', () => {
		// Mock a non-PR scenario (e.g., push, schedule, workflow_dispatch)
		vi.mocked(github.context).payload = {};

		setupDocsWithScript();

		// Should spawn the child process
		expect(mockSpawnSync).toHaveBeenCalledTimes(1);
		expect(mockCoreInfo).toHaveBeenCalledWith('Running docs setup script via pnpm tsx scripts/setup-docs.ts');
	});

	it('should throw error when spawn fails', () => {
		const spawnError = new Error('spawn ENOENT');
		mockSpawnSync.mockReturnValue({
			error: spawnError,
			status: null,
			signal: null,
			output: [],
			pid: 0,
			stdout: null,
			stderr: null,
		});

		expect(() => setupDocsWithScript()).toThrow('spawn ENOENT');
	});

	it('should throw error when setup script exits with non-zero status', () => {
		mockSpawnSync.mockReturnValue({
			status: 1,
			signal: null,
			output: [],
			pid: 12345,
			stdout: null,
			stderr: null,
		});

		expect(() => setupDocsWithScript()).toThrow('setup-docs script failed with exit code 1');
	});

	it('should call spawnSync with correct command and arguments', () => {
		setupDocsWithScript();

		expect(mockSpawnSync).toHaveBeenCalledWith(
			'pnpm',
			['tsx', 'scripts/setup-docs.ts', '--vercel'],
			expect.objectContaining({
				stdio: 'inherit',
				env: expect.any(Object),
			})
		);
	});

	it('should not leak GitHub Actions secrets through environment', () => {
		// Add more GitHub Actions secret patterns
		process.env.ACTIONS_RUNTIME_TOKEN = 'actions_runtime_secret';
		process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'id_token_secret';
		process.env.RUNNER_TOKEN = 'runner_secret_token';

		setupDocsWithScript();

		const spawnCall = mockSpawnSync.mock.calls[0];
		const env = spawnCall[2]?.env as Record<string, string>;

		expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
		expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
		expect(env.RUNNER_TOKEN).toBeUndefined();

		// Clean up
		delete process.env.ACTIONS_RUNTIME_TOKEN;
		delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
		delete process.env.RUNNER_TOKEN;
	});

	it('should enforce strict allowlist - no process.env spread', () => {
		// Add a variety of environment variables that should NOT be passed
		process.env.CUSTOM_SECRET = 'custom_secret_value';
		process.env.DATABASE_URL = 'postgresql://user:pass@host/db';
		process.env.API_KEY = 'api_key_12345';
		process.env.PRIVATE_KEY = 'private_key_data';

		setupDocsWithScript();

		const spawnCall = mockSpawnSync.mock.calls[0];
		const env = spawnCall[2]?.env as Record<string, string>;

		// Verify none of these custom secrets are passed
		expect(env.CUSTOM_SECRET).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.API_KEY).toBeUndefined();
		expect(env.PRIVATE_KEY).toBeUndefined();

		// Verify only allowlisted keys exist (plus CONSENT_GIT_TOKEN)
		const allowedKeys = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'NODE_ENV', 'CI', 'LANG', 'LC_ALL', 'LC_CTYPE', 'CONSENT_GIT_TOKEN'];
		const envKeys = Object.keys(env);
		
		for (const key of envKeys) {
			expect(allowedKeys).toContain(key);
		}

		// Clean up
		delete process.env.CUSTOM_SECRET;
		delete process.env.DATABASE_URL;
		delete process.env.API_KEY;
		delete process.env.PRIVATE_KEY;
	});
});
