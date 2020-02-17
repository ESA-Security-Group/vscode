/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { Event, Emitter, AsyncEmitter } from 'vs/base/common/event';
import { URI } from 'vs/base/common/uri';
import { Disposable } from 'vs/base/common/lifecycle';
import { FileOperationWillRunEvent, FileOperationDidRunEvent } from 'vs/workbench/services/textfile/common/textfiles';
import { IFileService, FileOperation } from 'vs/platform/files/common/files';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IWorkingCopyService } from 'vs/workbench/services/workingCopy/common/workingCopyService';
import { isEqualOrParent } from 'vs/base/common/resources';

export const IWorkingCopyFileService = createDecorator<IWorkingCopyFileService>('workingCopyFileService');

export interface IWorkingCopyFileService {

	_serviceBrand: undefined;


	//#region Events

	/**
	 * An event that is fired before attempting a certain working copy file operation.
	 */
	readonly onWillRunOperation: Event<FileOperationWillRunEvent>;

	/**
	 * An event that is fired after a working copy file operation has been performed.
	 */
	readonly onDidRunOperation: Event<FileOperationDidRunEvent>;

	//#endregion


	//#region File operations

	/**
	 * Delete a file. If the file is dirty, it will get reverted and then deleted from disk.
	 */
	delete(resource: URI, options?: { useTrash?: boolean, recursive?: boolean }): Promise<void>;

	//#endregion
}

export class WorkingCopyFileService extends Disposable implements IWorkingCopyFileService {

	_serviceBrand: undefined;

	//#region Events

	private readonly _onWillRunOperation = this._register(new AsyncEmitter<FileOperationWillRunEvent>());
	readonly onWillRunOperation = this._onWillRunOperation.event;

	private readonly _onDidRunOperation = this._register(new Emitter<FileOperationDidRunEvent>());
	readonly onDidRunOperation = this._onDidRunOperation.event;

	//#endregion

	constructor(
		@IFileService private fileService: IFileService,
		@IWorkingCopyService private workingCopyService: IWorkingCopyService
	) {
		super();
	}

	//#region File operations

	async delete(resource: URI, options?: { useTrash?: boolean, recursive?: boolean }): Promise<void> {

		// before event
		await this._onWillRunOperation.fireAsync({ operation: FileOperation.DELETE, target: resource }, CancellationToken.None);

		// Check for any existing dirty working copies for the resource
		// and do a soft revert before deleting to be able to close
		// any opened editor with these working copies
		const dirtyWorkingCopies = this.workingCopyService.dirtyWorkingCopies.filter(dirty => isEqualOrParent(dirty.resource, resource));
		await Promise.all(dirtyWorkingCopies.map(dirtyWorkingCopy => dirtyWorkingCopy.revert({ soft: true })));

		// Now actually delete from disk
		await this.fileService.del(resource, options);

		// after event
		this._onDidRunOperation.fire(new FileOperationDidRunEvent(FileOperation.DELETE, resource));
	}

	//#endregion
}

registerSingleton(IWorkingCopyFileService, WorkingCopyFileService, true);
