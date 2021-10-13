/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference path='../../../src/vs/vscode.d.ts'/>

import * as vscode from 'vscode';
import { createSession, storeAuthSessions, getValidSessions } from './auth';

export default class GitpodAuthSession {
	private _sessionChangeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	private _disposable: vscode.Disposable;
	private _sessionsPromise: Promise<vscode.AuthenticationSession[]>;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.context = context;
		this._sessionsPromise = this.readSessions();
		this._disposable = vscode.Disposable.from(
			vscode.authentication.registerAuthenticationProvider('gitpod', 'Gitpod', this, { supportsMultipleAccounts: false }),
			this.context.secrets.onDidChange(() => this.checkForUpdates())
		);
	}

	dispose() {
		this._disposable.dispose();
	}

	get onDidChangeSessions() {
		return this._sessionChangeEmitter.event;
	}

	public async createSession(scopes: string[]): Promise<vscode.AuthenticationSession> {
		try {
			return createSession(scopes, this.context);
		} catch (e) {
			// If login was cancelled, do not notify user.
			if (e === 'Cancelled') {
				throw e;
			}

			vscode.window.showErrorMessage(`Sign in failed: ${e}`);
			throw e;
		}
	}

	public async removeSession(id: string) {
		try {
			const sessions = this.readSessions();
			const filteredSessions = (await sessions).filter((session) => session.id !== id);
			await storeAuthSessions(filteredSessions, this.context);
		} catch (e) {
			vscode.window.showErrorMessage(`Sign out failed: ${e}`);
			throw e;
		}
	}

	async getSessions(scopes?: string[]): Promise<vscode.AuthenticationSession[]> {
		return getValidSessions(this.context, scopes);
	}

	public async readSessions(): Promise<vscode.AuthenticationSession[]> {
		const existingSessionsJSON = await this.context.secrets.get('gitpod.authSessions') || '[]';
		const sessions: vscode.AuthenticationSession[] = JSON.parse(existingSessionsJSON);
		return sessions;
	}

	public async setSessions(sessions: vscode.AuthenticationSession[]) {
		const parsedSessions = JSON.stringify(sessions);
		await this.context.secrets.store('gitpod.authSessions', parsedSessions);
	}

	private async checkForUpdates() {
		const previousSessions = await this._sessionsPromise;
		this._sessionsPromise = this.readSessions();
		const storedSessions = await this._sessionsPromise;

		const added: vscode.AuthenticationSession[] = [];
		const removed: vscode.AuthenticationSession[] = [];

		storedSessions.forEach(session => {
			const matchesExisting = previousSessions.some(s => s.id === session.id);
			// Another window added a session to the keychain, add it to our state as well
			if (!matchesExisting) {
				added.push(session);
			}
		});

		previousSessions.forEach(session => {
			const matchesExisting = storedSessions.some(s => s.id === session.id);
			// Another window has logged out, remove from our state
			if (!matchesExisting) {
				removed.push(session);
			}
		});

		if (added.length || removed.length) {
			this._sessionChangeEmitter.fire({ added, removed, changed: [] });
		}
	}
}
