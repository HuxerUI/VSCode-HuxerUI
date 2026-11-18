/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const byId = (id) => document.getElementById(id);
const value = (id) => byId(id).value;
const platformNames = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS', web: 'Web' };
const draft = vscode.getState();
let projects = [];
let project;
let host;
let creating = draft?.creating;
let sourceSdk = false;
let statusReady = false;
const abiChoicesByProject = new Map();
let deviceChoices = [];

function send(type, data = {}) {
  vscode.postMessage({ type, project: project?.id, area: creating ? 'create' : 'project', ...data });
}

function setStatus(area, message, error = false) {
  const label = byId(area + '-status');
  label.textContent = message;
  label.classList.toggle('error', error);
}

function selectedPlatforms(group) {
  return [...byId(group).querySelectorAll('input:checked')].map((input) => input.value);
}

function kind() {
  return document.querySelector('input[name="kind"]:checked').value;
}

function saveDraft() {
  vscode.setState({
    name: value('name'),
    projectId: value('project-id'),
    kind: kind(),
    buildSystem: value('build-system'),
    template: value('template'),
    appPlatforms: selectedPlatforms('platforms'),
    libraryPlatforms: selectedPlatforms('library-platforms'),
    creating,
  });
}

function renderCreationOptions() {
  const app = kind() === 'app';
  const cmake = value('build-system') === 'cmake';
  byId('project-id-field').hidden = !cmake;
  byId('project-id').disabled = !cmake;
  byId('project-id').placeholder = app ? 'com.example.myapp' : 'com.example.mylibrary';
  byId('platform-field').hidden = !app || !cmake;
  byId('library-platform-field').hidden = app || !cmake;
  byId('template-field').hidden = !app || cmake;
  byId('source-note').hidden = cmake || !sourceSdk;
  byId('create').textContent = app ? 'Create App' : 'Create Library';
  byId('name').placeholder = app ? 'MyApp' : 'MyLibrary';
}

function makePlatformOptions(group, platforms, defaults, checked = defaults) {
  byId(group).replaceChildren(...platforms.map((platform) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = platform;
    input.defaultChecked = defaults.includes(platform);
    input.checked = checked.includes(platform);
    label.append(input, platformNames[platform]);
    return label;
  }));
}

function showMode(load = true) {
  byId('create-section').hidden = !creating;
  byId('project-section').hidden = creating || !project;
  byId('back').hidden = !project;
  if (load) {
    renderCreationOptions();
    byId('project-rebuild-cli').hidden = true;
    if (creating || project?.buildSystem === 'cmake') {
      send('sdkList');
    }
    if (!creating && project?.buildSystem !== 'cmake') {
      refreshDevices();
    }
  }
}

function changeMode(next) {
  creating = next;
  showMode();
  saveDraft();
}

function renderProject() {
  const cmake = project?.buildSystem === 'cmake';
  byId('target-field').hidden = !cmake || !project.targets.length;
  byId('project-sdk-field').hidden = !cmake;
  byId('project-advanced').hidden = !cmake;
  if (!project) {
    return;
  }
  const settings = project.settings;
  byId('target').replaceChildren(...project.targets.map((target) => new Option(platformNames[target], target)));
  if (project.targets.includes(settings.target)) {
    byId('target').value = settings.target;
  }
  byId('configuration').value = settings.configuration ?? '';
  byId('optimization').value = settings.optimization ?? '';
  byId('lto').value = settings.lto ?? '';
  byId('configuration-note').hidden = Boolean(settings.configuration);
  const buttons = document.querySelectorAll('[data-action]');
  for (const button of buttons) {
    const action = button.dataset.action;
    button.hidden = !(project.actions.includes(action) ||
      (action === 'debug' && project.debug) || (action === 'artifacts' && cmake) ||
      (action === 'setup' && cmake && project.targets.length > 0) || action === 'stop');
  }
  updateTargetControls();
  setStatus('project', '');
}

function updateTargetControls() {
  byId('device-field').hidden = !mobileTarget();
  byId('continue-device').hidden = !mobileTarget() || project?.pendingDeviceTarget !== value('target');
  document.querySelector('[data-action="debug"]').hidden = !project?.debug || value('target') !== host;
  renderAbi();
}

function renderAbi() {
  const target = value('target');
  const available = abiChoicesByProject.get(project?.id)?.[target] ?? [];
  const physical = target === 'ios' && deviceChoices.some(device => device.id === value('device') && device.kind === 'physical');
  const choices = physical ? available.filter(abi => abi === 'arm64') : available;
  byId('abi-field').hidden = !choices.length;
  const options = [new Option('Auto', '')];
  if (target === 'android') {
    options.push(new Option('Follow Device', 'device'));
  }
  options.push(...choices.map(abi => new Option(abi, abi)));
  if (choices.length > 1) {
    options.push(new Option(choices.join(' + '), choices.join(',')));
  }
  const select = byId('abi');
  select.replaceChildren(...options);
  const preferred = project?.settings.abiByTarget?.[target] ?? '';
  select.value = options.some(option => option.value === preferred) ? preferred : '';
  updateAbiHelp();
}

function updateAbiHelp() {
  const target = value('target');
  byId('abi-help').textContent = target === 'android' && value('abi') === 'device'
    ? 'Build and Run follow the device. Package uses project defaults.'
    : {
        android: 'Auto follows the device for Run. Build and Package use project defaults.',
        ios: 'Physical devices require arm64. Auto uses the Xcode destination settings.',
        linux: 'Run uses one ABI. Cross-builds use the configured CMake toolchain.',
        macos: 'Universal builds require dependencies for both architectures.',
      }[target] ?? '';
}

function currentPreferences() {
  return {
    target: value('target'),
    configuration: value('configuration'),
    optimization: value('optimization'),
    lto: value('lto'),
    abi: byId('abi-field').hidden ? undefined : value('abi'),
    device: byId('device').disabled ? project?.settings.devices?.[value('target')] : value('device'),
  };
}

function savePreferences(targetChanged = false) {
  if (!project) {
    return;
  }
  const values = currentPreferences();
  if (targetChanged) {
    delete values.device;
    delete values.abi;
  }
  const devices = { ...project.settings.devices };
  const abiByTarget = { ...project.settings.abiByTarget };
  if (typeof values.device === 'string' && mobileTarget()) {
    devices[values.target] = values.device;
  }
  if (typeof values.abi === 'string') {
    abiByTarget[values.target] = values.abi;
  }
  project.settings = { ...values, devices, abiByTarget };
  send('preferences', values);
}

function mobileTarget() {
  const target = value('target');
  return target === 'android' || target === 'ios';
}

function refreshDevices() {
  deviceChoices = [];
  const mobile = project?.buildSystem === 'cmake' && mobileTarget();
  byId('device-field').hidden = !mobile;
  if (mobile) {
    byId('device').replaceChildren(new Option('Loading devices…', ''));
    byId('device').disabled = true;
    byId('device-help').hidden = true;
    send('devices', { target: value('target') });
  }
  renderAbi();
}

function renderSdk(message) {
  if (message.area === 'project' && message.project !== project?.id) {
    return;
  }
  const select = byId(message.area + '-sdk');
  const options = message.choices.map((choice, index) => {
    const label = choice.root && choice.detail ? choice.label + ' · ' + choice.detail : choice.label;
    const option = new Option(label, String(index));
    option.title = choice.detail ?? choice.label;
    if (choice.root && choice.root === message.current) {
      option.selected = true;
    }
    return option;
  });
  if (!options.some((option) => option.selected)) {
    const active = message.current ? 'Current SDK · ' + message.current : 'Select an SDK…';
    options.unshift(new Option(active, '', true, true));
  }
  select.replaceChildren(...options);
  select.disabled = false;
  if (message.area === 'create') {
    sourceSdk = message.source;
    renderCreationOptions();
  } else {
    abiChoicesByProject.set(message.project, message.abiChoices);
    renderAbi();
    const rebuild = byId('project-rebuild-cli');
    rebuild.hidden = !message.rebuildSource;
    rebuild.disabled = false;
    if (!creating) {
      refreshDevices();
    }
  }
}

window.addEventListener('message', ({ data: message }) => {
  if (message.type === 'state') {
    const previous = project?.id;
    host = message.host;
    projects = message.projects;
    project = projects.find((item) => item.id === message.project) ?? projects[0];
    creating = project ? creating ?? false : true;
    const choices = projects.map((item) => {
      const name = item.name + (item.buildSystem === 'mcpp' ? ' · mcpp' : '');
      const option = new Option(name, item.id);
      option.title = item.detail;
      return option;
    });
    byId('project').replaceChildren(...choices);
    byId('project').value = project?.id ?? '';
    byId('parent').value = message.parent ?? '';
    byId('trust').hidden = message.trusted;
    byId('create-fields').disabled = !message.trusted;
    byId('project-fields').disabled = !message.trusted;
    if (!statusReady) {
      makePlatformOptions('platforms', message.platforms, message.defaultAppPlatforms, draft?.appPlatforms);
      makePlatformOptions('library-platforms', message.platforms, [], draft?.libraryPlatforms);
    }
    renderProject();
    showMode(!statusReady || previous !== project?.id);
    statusReady = true;
  } else if (message.type === 'sdk') {
    renderSdk(message);
  } else if (message.type === 'parent') {
    byId('parent').value = message.value;
    byId('create-sdk').replaceChildren(new Option('Finding SDKs…', ''));
    send('sdkList');
  } else if (message.type === 'devices' && message.project === project?.id && message.target === value('target')) {
    const { devices, target } = message;
    deviceChoices = devices;
    const last = project.settings.devices?.[target];
    const supported = abiChoicesByProject.get(message.project)?.[target] ?? [];
    const deviceAbi = device => device.abis?.find(abi => supported.includes(abi));
    const options = devices.map(device => new Option([device.label, deviceAbi(device)].filter(Boolean).join(' · '),
      device.id, false, device.id === last));
    const automaticAbi = devices.length === 1 ? deviceAbi(devices[0]) : undefined;
    const automatic = automaticAbi ? 'Auto · ' + automaticAbi : 'Auto';
    options.unshift(new Option(devices.length ? automatic : 'No ready devices', '', !last, !last));
    if (last && !devices.some(device => device.id === last)) {
      options.splice(1, 0, new Option('Selected device is unavailable', last, false, true));
    }
    byId('device').replaceChildren(...options);
    byId('device').disabled = false;
    byId('device-help').textContent = message.help;
    byId('device-help').hidden = devices.length > 0;
    renderAbi();
  } else if (message.type === 'deviceAction') {
    const owner = projects.find(item => item.id === message.project);
    if (owner) {
      owner.pendingDeviceTarget = message.target;
      if (owner === project) {
        updateTargetControls();
      }
    }
  } else if (message.type === 'error') {
    const area = message.area === 'create' ? 'create' : 'project';
    if (area === 'project' && ((message.project && message.project !== project?.id) ||
        (message.target && message.target !== value('target')))) {
      return;
    }
    setStatus(area, message.message, true);
    byId(area + '-sdk').disabled = false;
    if (area === 'project') {
      byId('project-rebuild-cli').disabled = false;
    }
    byId('create').disabled = false;
    byId('open-existing').hidden = !message.existing;
  } else if (message.type === 'projectStatus' && message.project === project?.id &&
      (!message.target || message.target === value('target'))) {
    setStatus('project', message.message);
  } else if (message.type === 'created') {
    byId('create').disabled = false;
    byId('name').value = '';
    byId('project-id').value = '';
    for (const input of document.querySelectorAll('#platforms input, #library-platforms input')) {
      input.checked = input.defaultChecked;
    }
    setStatus('create', '');
    changeMode(false);
  }
});

if (draft) {
  byId('name').value = draft.name;
  byId('project-id').value = draft.projectId ?? '';
  const type = [...document.querySelectorAll('input[name="kind"]')].find((radio) => radio.value === draft.kind);
  if (type) type.checked = true;
  byId('build-system').value = draft.buildSystem;
  byId('template').value = draft.template;
}
byId('create-form').addEventListener('input', () => {
  renderCreationOptions();
  saveDraft();
});
byId('create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!value('parent')) {
    setStatus('create', 'Choose a parent folder.', true);
    byId('browse').focus();
    return;
  }
  byId('create').disabled = true;
  byId('open-existing').hidden = true;
  setStatus('create', 'Creating project…');
  send('create', {
    name: value('name'), projectId: value('project-id'), kind: kind(), buildSystem: value('build-system'),
    platforms: selectedPlatforms(kind() === 'app' ? 'platforms' : 'library-platforms'),
    template: value('template'),
  });
});
byId('browse').addEventListener('click', () => send('browseParent'));
byId('open-existing').addEventListener('click', () => send('openExisting'));
byId('new').addEventListener('click', () => changeMode(true));
byId('back').addEventListener('click', () => changeMode(false));
byId('project').addEventListener('change', () => {
  project = projects.find((item) => item.id === value('project'));
  send('selectProject');
  renderProject();
  showMode();
});
for (const area of ['create', 'project']) {
  const select = byId(area + '-sdk');
  select.addEventListener('change', () => {
    if (select.value !== '') {
      select.disabled = true;
      if (area === 'project') {
        byId('project-rebuild-cli').disabled = true;
      }
      setStatus(area, '');
      send('sdkSelect', { area, index: Number(select.value) });
    }
  });
}
byId('project-rebuild-cli').addEventListener('click', () => {
  byId('project-rebuild-cli').disabled = true;
  setStatus('project', 'Rebuilding the source CLI…');
  send('sdkRebuild');
});
byId('target').addEventListener('change', () => {
  savePreferences(true);
  updateTargetControls();
  refreshDevices();
});
for (const id of ['configuration', 'optimization', 'lto', 'device', 'abi']) {
  byId(id).addEventListener('change', () => {
    savePreferences();
    if (id === 'device') {
      renderAbi();
    } else if (id === 'abi') {
      updateAbiHelp();
    }
    byId('configuration-note').hidden = Boolean(value('configuration'));
  });
}
byId('refresh-devices').addEventListener('click', refreshDevices);
byId('continue-device').addEventListener('click', () => {
  const { target, device, abi } = currentPreferences();
  send('action', { action: 'continueDevice', target, device, abi });
});
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => {
    setStatus('project', '');
    send('action', { ...currentPreferences(), action: button.dataset.action });
  });
}
send('ready');
