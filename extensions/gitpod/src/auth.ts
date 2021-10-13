/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference path='../../../src/vs/vscode.d.ts'/>

import crypto from 'crypto';
import * as vscode from 'vscode';
const create = require('pkce').create;

import { GitpodClient, GitpodServer, GitpodServiceImpl } from '@gitpod/gitpod-protocol/lib/gitpod-service';
import { JsonRpcProxyFactory } from '@gitpod/gitpod-protocol/lib/messaging/proxy-factory';
import WebSocket = require('ws');
import ReconnectingWebSocket from 'reconnecting-websocket';
import { ConsoleLogger, listen as doListen } from 'vscode-ws-jsonrpc';

export const authCompletePath = '/auth-complete';
const baseURL = vscode.workspace.getConfiguration('gitpod').get('authOrigin', 'https://gitpod.io');

type UsedGitpodFunction = ['getLoggedInUser', 'getGitpodTokenScopes'];
type Union<Tuple extends any[], Union = never> = Tuple[number] | Union;
export type GitpodConnection = Omit<GitpodServiceImpl<GitpodClient, GitpodServer>, 'server'> & {
	server: Pick<GitpodServer, Union<UsedGitpodFunction>>
};
const gitpodFunctions: UsedGitpodFunction = ['getLoggedInUser', 'getGitpodTokenScopes'];

export const gitpodScopes = new Set<string>([
	'function:accessCodeSyncStorage',
	'resource:default'
]);
for (const gitpodFunction of gitpodFunctions) {
	gitpodScopes.add('function:' + gitpodFunction);
}

export interface PromiseAdapter<T, U> {
	(
		value: T,
		resolve:
			(value: U | PromiseLike<U>) => void,
		reject:
			(reason: any) => void
	): any;
}

const passthrough = (value: any, resolve: (value?: any) => void) => resolve(value);

/**
 * Return a promise that resolves with the next emitted event, or with some future
 * event as decided by an adapter.
 *
 * If specified, the adapter is a function that will be called with
 * `(event, resolve, reject)`. It will be called once per event until it resolves or
 * rejects.
 *
 * The default adapter is the passthrough function `(value, resolve) => resolve(value)`.
 *
 * @param event the event
 * @param adapter controls the resolution of the returned promise
 * @returns a promise that resolves or rejects as specified by the adapter
 */
function promiseFromEvent<T, U>(
	event: vscode.Event<T>,
	adapter: PromiseAdapter<T, U> = passthrough): { promise: Promise<U>, cancel: vscode.EventEmitter<void> } {
	let subscription: vscode.Disposable;
	let cancel = new vscode.EventEmitter<void>();
	return {
		promise: new Promise<U>((resolve, reject) => {
			cancel.event(_ => reject());
			subscription = event((value: T) => {
				try {
					Promise.resolve(adapter(value, resolve, reject))
						.catch(reject);
				} catch (error) {
					reject(error);
				}
			});
		}).then(
			(result: U) => {
				subscription.dispose();
				return result;
			},
			error => {
				subscription.dispose();
				throw error;
			}
		),
		cancel
	};
}

/**
 * Gets all auth sessions that are stored by the extension
 * @param context the VS Code Extension context
 * @returns a list of auth sessions.
 */
export async function getAuthSessions(context: vscode.ExtensionContext): Promise<vscode.AuthenticationSession[]> {
	const existingSessionsJSON = await context.secrets.get('gitpod.authSessions') || '[]';
	const sessions: vscode.AuthenticationSession[] = JSON.parse(existingSessionsJSON);
	return sessions;
}

/**
 * Stores a provided array of authentication sessions to the secret store
 * @param sessions an array of auth sessions to store
 * @param context the VS Code Extension context
 */
export async function storeAuthSessions(sessions: vscode.AuthenticationSession[], context: vscode.ExtensionContext): Promise<void> {
	const parsedSessions = JSON.stringify(sessions);
	await context.secrets.store('gitpod.authSessions', parsedSessions);
}

/**
 * Prompts the user to reload VS Code (executes native `workbench.action.reloadWindow`)
 * @param msg - optionally, overwrite the message to be displayed
*/
function promptToReload(msg?: string): void {
	const action = 'Reload';

	vscode.window.showInformationMessage(msg || `Reload VS Code for the new Settings Sync configuration to take effect.`, action)
		.then(selectedAction => {
			if (selectedAction === action) {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
}

const syncStoreURL = `${baseURL}/code-sync`;
const newConfig = {
	url: syncStoreURL,
	stableUrl: syncStoreURL,
	insidersUrl: syncStoreURL,
	canSwitch: true,
	authenticationProviders: {
		gitpod: {
			scopes: [...gitpodScopes]
		}
	}
};

/**
 * Returns a promise which waits until the secret store `gitpod.authSessions` item changes.
 * @returns a promise that resolves with newest added `vscode.AuthenticationSession`, or if no session is found, `null`
 */
async function waitForAuthenticationSession(context: vscode.ExtensionContext): Promise<vscode.AuthenticationSession | null> {
	console.log('Waiting for the onchange event');

	// Wait until a session is added to the context's secret store
	const authPromise = promiseFromEvent(context.secrets.onDidChange, (changeEvent: vscode.SecretStorageChangeEvent, resolve): void => {
		if (changeEvent.key === 'gitpod.authSessions') {
			resolve(changeEvent.key);
		}
	});
	const data: any = await authPromise.promise;

	console.log(data);

	console.log('Retrieving the session');

	const currentSessions = await getValidSessions(context);
	if (currentSessions.length > 0) {
		return currentSessions[currentSessions.length - 1];
	} else {
		vscode.window.showErrorMessage('Couldn\'t find any auth sessions');
		return null;
	}
}

/**
 * Checks all stored auth sessions and returns all valid ones
 * @param context the VS Code extension context from which to get the sessions from
 * @param scopes optionally, you can specify scopes to check against
 * @returns a list of sessions that are valid
 */
async function getValidSessions(context: vscode.ExtensionContext, scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
	const sessions = await getAuthSessions(context);

	for (const [index, session] of sessions.entries()) {
		const availableScopes = await checkScopes(session.accessToken);
		if (!(scopes || [...gitpodScopes]).every((scope) => availableScopes.includes(scope))) {
			vscode.window.showErrorMessage('Token invalid.');
			delete sessions[index];
		}
	}

	await storeAuthSessions(sessions, context);
	if (sessions.length === 0 && (await getAuthSessions(context)).length !== 0) {
		vscode.window.showErrorMessage('Your login session with Gitpod has expired. You need to sign in again.');
	}
	return sessions;
}

/**
 * Updates the VS Code context to reflect whether the user added Gitpod as their Settings Sync provider.
 */
async function updateSyncContext() {
	const config = vscode.workspace.getConfiguration();
	const syncConfig = config.get('configurationSync.store');
	const adddedSyncProvider = syncConfig && JSON.stringify(syncConfig) === JSON.stringify(newConfig);
	await vscode.commands.executeCommand('setContext', 'gitpod.addedSyncProvider', adddedSyncProvider);
}

/**
 * Adds an authentication provider as a possible provider for code sync.
 * It adds some key configuration to the user settings, so that the user can choose the Gitpod provider when deciding what to use with setting sync.
 * @param enabled - indicates whether to add or remove the configuration
 */
export async function setSettingsSync(enabled?: boolean): Promise<void> {
	const config = vscode.workspace.getConfiguration();
	if (!enabled) {
		try {
			await config.update('configurationSync.store', undefined, true);
			updateSyncContext();
			promptToReload();
		} catch (e) {
			vscode.window.showErrorMessage(`Error setting up code sync config: ${e}`);
		}
		return;
	}

	try {
		const currentConfig = await config.get('configurationSync.store');
		if (JSON.stringify(currentConfig) !== JSON.stringify(newConfig)) {
			await config.update('configurationSync.store', newConfig, true);
			updateSyncContext();
			promptToReload();
		}
	} catch (e) {
		vscode.window.showErrorMessage(`Error setting up code sync config: ${e}`);
	}
}

/**
 * Creates a WebSocket connection to Gitpod's API
 * @param accessToken an access token to create the WS connection with
 * @returns a tuple of `gitpodService` and `pendignWebSocket`
 */
async function createApiWebSocket(accessToken: string): Promise<{ gitpodService: GitpodConnection; pendignWebSocket: Promise<ReconnectingWebSocket>; }> {
	const factory = new JsonRpcProxyFactory<GitpodServer>();
	const gitpodService: GitpodConnection = new GitpodServiceImpl<GitpodClient, GitpodServer>(factory.createProxy()) as any;
	const pendignWebSocket = (async () => {
		class GitpodServerWebSocket extends WebSocket {
			constructor(address: string, protocols?: string | string[]) {
				super(address, protocols, {
					headers: {
						'Origin': baseURL,
						'Authorization': `Bearer ${accessToken}`
					}
				});
			}
		}
		const webSocketMaxRetries = 3;
		const webSocket = new ReconnectingWebSocket(baseURL.replace('https', 'wss'), undefined, {
			minReconnectionDelay: 1000,
			connectionTimeout: 10000,
			maxRetries: webSocketMaxRetries,
			debug: false,
			startClosed: false,
			WebSocket: GitpodServerWebSocket
		});

		let retry = 1;
		webSocket.onerror = (err) => {
			vscode.window.showErrorMessage(`WebSocket error: ${err.message} (#${retry}/${webSocketMaxRetries})`);
			if (retry++ === webSocketMaxRetries) {
				throw new Error('Maximum websocket connection retries exceeded');
			}
		};

		doListen({
			webSocket,
			logger: new ConsoleLogger(),
			onConnection: connection => factory.listen(connection),
		});
		return webSocket;
	})();

	return { gitpodService, pendignWebSocket };
}


/**
 * Returns a promise that resolves with the current authentication session of the provided access token. This includes the token itself, the scopes, the user's ID and name.
 * @param accessToken the access token used to authenticate the Gitpod WS connection
 * @param scopes the authentication session must have
 * @returns a promise that resolves with the authentication session
 */
export async function resolveAuthenticationSession(scopes: readonly string[], accessToken: string): Promise<vscode.AuthenticationSession | null> {
	try {
		const { gitpodService, pendignWebSocket } = await createApiWebSocket(accessToken);
		const user = await gitpodService.server.getLoggedInUser();
		(await pendignWebSocket).close();
		return {
			id: 'gitpod.user',
			account: {
				label: user.name!,
				id: user.id
			},
			scopes: scopes,
			accessToken: accessToken
		};
	} catch (e) {
		vscode.window.showErrorMessage(`Couldn't connect: ${e}`);
		return null;
	}
}

/**
 * @returns all of the scopes accessible for `accessToken`
 */
export async function checkScopes(accessToken: string): Promise<string[]> {
	try {
		const { gitpodService, pendignWebSocket } = await createApiWebSocket(accessToken);
		const hash = crypto.createHash('sha256').update(accessToken, 'utf8').digest('hex');
		const scopes = await gitpodService.server.getGitpodTokenScopes(hash);
		(await pendignWebSocket).close();
		return scopes;
	} catch (e) {
		vscode.window.showErrorMessage(`Couldn't connect: ${e}`);
		return [];
	}
}

/**
 * Creates a URL to be opened for the whole OAuth2 flow to kick-off
 * @returns a `URL` string containing the whole auth URL
 */
function createOauth2URL(options: { authorizationURI: string, clientID: string, redirectURI: vscode.Uri, scopes: string[] }): vscode.Uri {
	const { authorizationURI, clientID, redirectURI, scopes } = options;
	const { codeChallenge }: { codeChallenge: string, codeVerifier: string } = create();

	let query = '';
	function set(field: string, value: string): void {
		if (query) {
			query += '&';
		}
		query += `${field}=${value}`;
	}

	set('client_id', clientID);
	set('redirect_uri', redirectURI.toString());
	set('response_type', 'code');
	set('scope', scopes.join(' '));
	set('code_challenge', codeChallenge);
	set('code_challenge_method', 'S256');

	return vscode.Uri.parse(authorizationURI).with({ query });
}

/**
 * Asks the user to setup Settings Sync
 * @param context the extension context
 */
async function askToEnable(context: vscode.ExtensionContext): Promise<void> {
	if (!(await context.secrets.get('gitpod.syncPopupShown'))) {
		vscode.window.showInformationMessage('Would you like to use Settings Sync with Gitpod?', 'Yes', 'No')
			.then(async selectedAction => {
				await context.globalState.update('gitpod.syncPopupShown', 'true');
				if (selectedAction === 'Yes') {
					setSettingsSync(true);
				}
			});
	}
}

/**
 * Adds a authentication provider to the provided extension context
 * @param context the extension context to act upon and the context to which push the authentication service
 * @param logger a function used for logging outputs
 */
export function registerAuth(context: vscode.ExtensionContext, logger: (value: string) => void): void {

	const removeCmd = vscode.commands.registerCommand('gitpod.auth.remove', () => {
		setSettingsSync(false);
	});
	context.subscriptions.push(removeCmd);

	const addCmd = vscode.commands.registerCommand('gitpod.auth.add', () => {
		setSettingsSync(true);
	});
	context.subscriptions.push(addCmd);

	async function createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		const callbackUri = vscode.Uri.parse(`${vscode.env.uriScheme}://gitpod.gitpod-desktop/complete-gitpod-auth`);

		if (![...gitpodScopes].every((scope) => scopes.includes(scope))) {
			vscode.window.showErrorMessage('The provided scopes are not enough to turn on Settings Sync');
		}

		const gitpodAuth = createOauth2URL({
			clientID: `${vscode.env.uriScheme}-gitpod`,
			authorizationURI: `${baseURL}/api/oauth/authorize`,
			redirectURI: callbackUri,
			scopes: [...gitpodScopes],
		});

		const timeoutPromise = new Promise((_: (value: vscode.AuthenticationSession) => void, reject): void => {
			const wait = setTimeout(() => {
				clearTimeout(wait);
				vscode.window.showErrorMessage('Login timed out, please try to sign in again.');
				reject('Login timed out.');
			}, 1000 * 60 * 5); // 5 minutes
		});

		// Todo(ft): fix query encoding problems
		const opened = await vscode.env.openExternal(gitpodAuth);
		if (!opened) {
			const selected = await vscode.window.showErrorMessage(`Couldn't open ${gitpodAuth.toString(true)} automatically, please copy and paste it to your browser manually.`, 'Copy', 'Cancel');
			if (selected === 'Copy') {
				vscode.env.clipboard.writeText(gitpodAuth.toString(true));
				logger('Copied auth URL');
			}
		}
		return Promise.race([timeoutPromise, (await waitForAuthenticationSession(context))!]);
	}

	const onDidChangeSessionsEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	context.subscriptions.push(onDidChangeSessionsEmitter);
	logger('Registering authentication provider...');
	context.subscriptions.push(vscode.authentication.registerAuthenticationProvider('gitpod', 'Gitpod', {
		onDidChangeSessions: onDidChangeSessionsEmitter.event,
		getSessions: async (scopes: string[]) => {
			return getValidSessions(context, scopes);
		},
		createSession: async (scopes: string[]) => {
			return createSession(scopes);
		},
		removeSession: async (sessionId) => {
			const sessions = getAuthSessions(context);
			const filteredSessions = (await sessions).filter((session) => session.id !== sessionId);
			await storeAuthSessions(filteredSessions, context);
		},
	}, { supportsMultipleAccounts: false }));
	logger('Pushed auth');
	updateSyncContext();
	askToEnable(context);
}
