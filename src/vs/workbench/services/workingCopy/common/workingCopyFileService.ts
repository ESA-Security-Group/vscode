/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { Event, AsyncEmitter } from 'vs/base/common/event';
import { URI } from 'vs/base/common/uri';
import { Disposable } from 'vs/base/common/lifecycle';
import { IFileService, FileOperation, FileOperationWillRunEvent, FileOperationDidRunEvent, IFileStatWithMetadata, FileOperationDidFailEvent } from 'vs/platform/files/common/files';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IWorkingCopyService, IWorkingCopy } from 'vs/workbench/services/workingCopy/common/workingCopyService';
import { isEqualOrParent, isEqual } from 'vs/base/common/resources';

export const IWorkingCopyFileService = createDecorator<IWorkingCopyFileService>('workingCopyFileService');

// TODO@Ben: maybe a better model is that everything is done from the outside
// like revert and co because the extension should participate?
// should then also fix delete() and must introduce some event correlation
// for the before and after hooks...
// Also: text file model manager should listen, not text file service!
export interface IWorkingCopyFileService {

	_serviceBrand: undefined;


	//#region Events

	/**
	 * An event that is fired before attempting a certain working copy IO operation.
	 */
	readonly onWillRunWorkingCopyFileOperation: Event<FileOperationWillRunEvent>;

	/**
	 * An event that is fired after a working copy IO operation has failed.
	 */
	readonly onDidFailWorkingCopyFileOperation: Event<FileOperationDidFailEvent>;

	/**
	 * An event that is fired after a working copy IO operation has been performed.
	 */
	readonly onDidRunWorkingCopyFileOperation: Event<FileOperationDidRunEvent>;

	//#endregion


	//#region File operations

	/**
	 * Will move working copies matching the provided resource and children
	 * to the target resource using the associated file service for that resource.
	 *
	 * Working copy owners can listen to the `onWillRunWorkingCopyFileOperation` and
	 * `onDidRunWorkingCopyFileOperation` events to participate.
	 */
	move(source: URI, target: URI, overwrite?: boolean): Promise<IFileStatWithMetadata>;

	/**
	 * Will copy working copies matching the provided resource and children
	 * to the target using the associated file service for that resource.
	 *
	 * Working copy owners can listen to the `onWillRunWorkingCopyFileOperation` and
	 * `onDidRunWorkingCopyFileOperation` events to participate.
	 */
	copy(source: URI, target: URI, overwrite?: boolean): Promise<IFileStatWithMetadata>;

	/**
	 * Will delete working copies matching the provided resource and children
	 * using the associated file service for that resource.
	 *
	 * Working copy owners can listen to the `onWillRunWorkingCopyFileOperation` and
	 * `onDidRunWorkingCopyFileOperation` events to participate.
	 */
	delete(resource: URI, options?: { useTrash?: boolean, recursive?: boolean }): Promise<void>;

	//#endregion
}

export class WorkingCopyFileService extends Disposable implements IWorkingCopyFileService {

	_serviceBrand: undefined;

	//#region Events

	private readonly _onWillRunWorkingCopyFileOperation = this._register(new AsyncEmitter<FileOperationWillRunEvent>());
	readonly onWillRunWorkingCopyFileOperation = this._onWillRunWorkingCopyFileOperation.event;

	private readonly _onDidFailWorkingCopyFileOperation = this._register(new AsyncEmitter<FileOperationDidFailEvent>());
	readonly onDidFailWorkingCopyFileOperation = this._onDidFailWorkingCopyFileOperation.event;

	private readonly _onDidRunWorkingCopyFileOperation = this._register(new AsyncEmitter<FileOperationDidRunEvent>());
	readonly onDidRunWorkingCopyFileOperation = this._onDidRunWorkingCopyFileOperation.event;

	//#endregion

	private correlationIds = 0;

	constructor(
		@IFileService private fileService: IFileService,
		@IWorkingCopyService private workingCopyService: IWorkingCopyService
	) {
		super();
	}

	async move(source: URI, target: URI, overwrite?: boolean): Promise<IFileStatWithMetadata> {
		return this.moveOrCopy(source, target, true, overwrite);
	}

	async copy(source: URI, target: URI, overwrite?: boolean): Promise<IFileStatWithMetadata> {
		return this.moveOrCopy(source, target, false, overwrite);
	}

	private async moveOrCopy(source: URI, target: URI, move: boolean, overwrite?: boolean): Promise<IFileStatWithMetadata> {
		const correlationId = this.correlationIds++;

		// before event
		await this._onWillRunWorkingCopyFileOperation.fireAsync({ correlationId, operation: move ? FileOperation.MOVE : FileOperation.COPY, target, source }, CancellationToken.None);

		// handle dirty working copies depending on the operation:
		// - move: revert both source and target (if any)
		// - copy: revert target (if any)
		const dirtyWorkingCopies = (move ? [...this.getDirtyWorkingCopies(source), ...this.getDirtyWorkingCopies(target)] : this.getDirtyWorkingCopies(target));
		await Promise.all(dirtyWorkingCopies.map(dirtyWorkingCopy => dirtyWorkingCopy.revert({ soft: true })));

		// now we can rename the source to target via file operation
		let stat: IFileStatWithMetadata;
		try {
			if (move) {
				stat = await this.fileService.move(source, target, overwrite);
			} else {
				stat = await this.fileService.copy(source, target, overwrite);
			}
		} catch (error) {
			await this._onDidFailWorkingCopyFileOperation.fireAsync({ correlationId, operation: move ? FileOperation.MOVE : FileOperation.COPY, target, source }, CancellationToken.None);

			throw error;
		}

		// after event
		await this._onDidRunWorkingCopyFileOperation.fireAsync({ correlationId, operation: move ? FileOperation.MOVE : FileOperation.COPY, target, source }, CancellationToken.None);

		return stat;
	}

	async delete(resource: URI, options?: { useTrash?: boolean, recursive?: boolean }): Promise<void> {
		const correlationId = this.correlationIds++;

		// before event
		await this._onWillRunWorkingCopyFileOperation.fireAsync({ correlationId, operation: FileOperation.DELETE, target: resource }, CancellationToken.None);

		// Check for any existing dirty working copies for the resource
		// and do a soft revert before deleting to be able to close
		// any opened editor with these working copies
		const dirtyWorkingCopies = this.getDirtyWorkingCopies(resource);
		await Promise.all(dirtyWorkingCopies.map(dirtyWorkingCopy => dirtyWorkingCopy.revert({ soft: true })));

		// Now actually delete from disk
		try {
			await this.fileService.del(resource, options);
		} catch (error) {
			await this._onDidFailWorkingCopyFileOperation.fireAsync({ correlationId, operation: FileOperation.DELETE, target: resource }, CancellationToken.None);

			throw error;
		}

		// after event
		await this._onDidRunWorkingCopyFileOperation.fireAsync({ correlationId, operation: FileOperation.DELETE, target: resource }, CancellationToken.None);
	}

	private getDirtyWorkingCopies(resource: URI): IWorkingCopy[] {
		return this.workingCopyService.dirtyWorkingCopies.filter(dirty => {
			if (this.fileService.canHandleResource(resource)) {
				// only check for parents if the resource can be handled
				// by the file system where we then assume a folder like
				// path structure
				return isEqualOrParent(dirty.resource, resource);
			}

			return isEqual(dirty.resource, resource);
		});
	}
}

registerSingleton(IWorkingCopyFileService, WorkingCopyFileService, true);
