/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { TextFileEditorModel } from 'vs/workbench/services/textfile/common/textFileEditorModel';
import { TextFileEditorModelManager } from 'vs/workbench/services/textfile/common/textFileEditorModelManager';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { toResource } from 'vs/base/test/common/utils';
import { workbenchInstantiationService, TestTextFileService } from 'vs/workbench/test/browser/workbenchTestServices';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IWorkingCopyFileService } from 'vs/workbench/services/workingCopy/common/workingCopyFileService';
import { IWorkingCopyService } from 'vs/workbench/services/workingCopy/common/workingCopyService';

class ServiceAccessor {
	constructor(
		@ITextFileService public textFileService: TestTextFileService,
		@IWorkingCopyFileService public workingCopyFileService: IWorkingCopyFileService,
		@IWorkingCopyService public workingCopyService: IWorkingCopyService
	) {
	}
}

suite('WorkingCopyFileService', () => {

	let instantiationService: IInstantiationService;
	let model: TextFileEditorModel;
	let accessor: ServiceAccessor;

	setup(() => {
		instantiationService = workbenchInstantiationService();
		accessor = instantiationService.createInstance(ServiceAccessor);
	});

	teardown(() => {
		model?.dispose();
		(<TextFileEditorModelManager>accessor.textFileService.files).dispose();
	});

	test('delete - dirty file', async function () {
		model = instantiationService.createInstance(TextFileEditorModel, toResource.call(this, '/path/file.txt'), 'utf8', undefined);
		(<TextFileEditorModelManager>accessor.textFileService.files).add(model.resource, model);

		await model.load();
		model!.textEditorModel!.setValue('foo');
		assert.ok(accessor.workingCopyService.isDirty(model.resource));

		await accessor.workingCopyFileService.delete(model.resource);
		assert.ok(!accessor.workingCopyService.isDirty(model.resource));
	});

});
