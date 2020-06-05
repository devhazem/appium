import _ from 'lodash';
import path from 'path';
import { KNOWN_DRIVERS } from './drivers';
import DriverConfig, { INSTALL_TYPE_NPM, INSTALL_TYPE_GIT, INSTALL_TYPE_GITHUB,
                       INSTALL_TYPE_LOCAL } from './driver-config';
import NPM from './npm';
import { errAndQuit, log, spinWith, JSON_SPACES } from './cli-utils';
import { util, fs } from 'appium-support';

async function runDriverCommand (args) {
  // TODO driver config file should be locked while any of these commands are
  // running to prevent weird situations
  let jsonResult = null;
  const {json, appiumHome} = args;
  const logFn = (msg) => log(json, msg);
  const config = new DriverConfig(appiumHome, logFn);
  const cmd = new DriverCommand({config, json});
  try {
    await config.read();
    jsonResult = await cmd.execute(args);
  } catch (err) {
    errAndQuit(json, err);
  }

  if (json) {
    console.log(JSON.stringify(jsonResult, null, JSON_SPACES)); // eslint-disable-line no-console
  }
}

class DriverCommand {

  constructor ({config, json}) {
    this.config = config;
    this.json = json;
    this.npm = new NPM(this.config.appiumHome);
  }

  async execute (args) {
    if (!this[args.driverCommand]) {
      throw new Error(`Cannot handle driver command ${args.driverCommand}`);
    }
    return await this[args.driverCommand](args);
  }

  async list ({showInstalled, showUpdates}) {
    const lsMsg = `Listing ${showInstalled ? 'installed' : 'available'} drivers`;
    const drivers = {};

    for (const name of Object.keys(this.config.installedDrivers)) {
      drivers[name] = this.config.installedDrivers[name];
      drivers[name].installed = true;
    }

    if (!showInstalled) {
      for (const name of Object.keys(KNOWN_DRIVERS)) {
        if (!drivers[name]) {
          drivers[name] = {
            pkgName: KNOWN_DRIVERS[name],
            installed: false,
          };
        }
      }
    }

    await spinWith(this.json, lsMsg, async () => {
      if (showUpdates) {
        for (const [, data] of _.toPairs(drivers)) {
          const {version, pkgName, installType} = data;
          data.updateVersion = null;
          if (installType === INSTALL_TYPE_NPM) {
            const latestVersion = await this.npm.getLatestVersion(pkgName);
            if (!version || util.compareVersions(latestVersion, '>', version)) {
              data.updateVersion = latestVersion;
            }
          }
        }
      }
    });

    if (this.json) {
      return drivers;
    }

    for (const [
      name,
      {installType, installSpec, installed, updateVersion, version}
    ] of _.toPairs(drivers)) {
      let typeTxt;
      switch (installType) {
        case INSTALL_TYPE_GIT:
        case INSTALL_TYPE_GITHUB:
          typeTxt = `(cloned from ${installSpec})`.yellow;
          break;
        case INSTALL_TYPE_LOCAL:
          typeTxt = `(linked from ${installSpec})`.magenta;
          break;
        default:
          typeTxt = '(NPM)';
      }
      const installTxt = installed ?
        `@${version.yellow} ${('[installed ' + typeTxt + ']').green}` :
        ' [not installed]'.grey;
      const updateTxt = showUpdates && updateVersion ?
        ` [${updateVersion} available]`.magenta :
        '';

      console.log(`- ${name.yellow}${installTxt}${updateTxt}`); // eslint-disable-line no-console
    }

    return drivers;
  }

  async install ({driver, installType}) {
    log(this.json, `Attempting to find and install driver '${driver}'`);

    let driverData, installSpec = driver;

    if (installType === INSTALL_TYPE_LOCAL) {
      const msg = 'Linking driver from local path';
      const pkgJsonData = await spinWith(this.json, msg, async () => (
        await this.npm.linkPackage(installSpec))
      );
      driverData = this.getDriverFields(pkgJsonData);
      driverData.installPath = driverData.pkgName;
    } else if (installType === INSTALL_TYPE_GITHUB) {
      if (installSpec.split('/').length !== 2) {
        throw new Error(`Github driver spec ${installSpec} appeared to be invalid; ` +
                        'it should be of the form <org>/<repo>');
      }
      driverData = await this.installViaNpm({driver: installSpec});
    } else if (installType === INSTALL_TYPE_GIT) {
      driverData = await this.installViaNpm({driver: installSpec});
    } else {
      // at this point we have either an npm package or an appium verified driver
      // name. both of which will be installed via npm.
      // drivers installed via npm can include versions or tags after the '@'
      // sign, so check for that
      const [name, pkgVer] = installSpec.split('@');
      let pkgName;

      if (installType === INSTALL_TYPE_NPM) {
        // if we're installing a named package from npm, we don't need to check
        // against the appium driver list; just use the installSpec as is
        pkgName = name;
      } else {
        // if we're installing a named appium driver (like 'xcuitest') we need to
        // dereference the actual npm package ('appiupm-xcuitest-driver'), so
        // check it exists and get the correct package
        const knownNames = Object.keys(KNOWN_DRIVERS);
        if (!_.includes(knownNames, name)) {
          const msg = `Could not resolve driver; are you sure it's in the list ` +
                      `of supported drivers? ${JSON.stringify(knownNames)}`;
          throw new Error(msg);
        }
        pkgName = KNOWN_DRIVERS[name];
        // given that we'll use the install type in the driver json, store it as
        // 'npm' now
        installType = INSTALL_TYPE_NPM;
      }

      driverData = await this.installViaNpm({driver, pkgName, pkgVer});
    }

    const {driverName} = driverData;
    delete driverData.driverName;

    if (this.config.isInstalled(driverName)) {
      throw new Error(`A driver named '${driverName}' is already installed. ` +
                      `Did you mean to update? 'appium driver update'. See ` +
                      `installed drivers with 'appium driver list --installed'.`);
    }

    driverData.installType = installType;
    driverData.installSpec = installSpec;
    await this.config.addDriver(driverName, driverData);

    // log info for the user
    log(this.json, `Driver ${driverName}@${driverData.version} successfully installed`.green);
    log(this.json, `- automationName: ${driverData.automationName.green}`);
    log(this.json, `- platformNames: ${JSON.stringify(driverData.platformNames).green}`);

    return this.config.installedDrivers;
  }

  async installViaNpm ({driver, pkgName, pkgVer}) {
    let installPath = pkgName;
    if (!pkgName) {
      pkgName = driver;
      installPath = path.posix.basename(pkgName);
    }
    const npmSpec = `${pkgName}${pkgVer ? '@' + pkgVer : ''}`;
    const specMsg = npmSpec === driver ? '' : ` using NPM install spec '${npmSpec}'`;
    const msg = `Installing '${driver}'${specMsg}`;
    try {
      const pkgJsonData = await spinWith(this.json, msg, async () => (
        await this.npm.installPackage(path.resolve(this.config.appiumHome, installPath), pkgName, pkgVer)
      ));
      const driverData = this.getDriverFields(pkgJsonData);
      driverData.installPath = installPath;
      return driverData;
    } catch (err) {
      throw new Error(`Encountered an error when installing package: ${err.message}`);
    }
  }

  getDriverFields (pkgJsonData) {
    if (!pkgJsonData.appium) {
      throw new Error(`Installed driver did not have an 'appium' section in its ` +
                      `package.json file as expected`);
    }

    const {appium, name, version} = pkgJsonData;
    const {driverName, automationName, platformNames, mainClass} = appium;

    const reqFields = ['driverName', 'automationName', 'platformNames', 'mainClass'];
    const missingFields = reqFields.reduce((acc, field) => (
      appium[field] ? acc : [...acc, field]
    ), []);

    if (!_.isEmpty(missingFields)) {
      throw new Error(`Installed driver did not expose correct fields for compability ` +
                      `with Appium. Missing fields: ${JSON.stringify(missingFields)}`);
    }

    return {version, pkgName: name, driverName, automationName, platformNames, mainClass};
  }

  async uninstall ({driver}) {
    if (!this.config.isInstalled(driver)) {
      throw new Error(`Can't uninstall driver '${driver}'; it is not installed`);
    }
    try {
      await fs.rimraf(this.config.getInstallPath(driver));
    } finally {
      await this.config.removeDriver(driver);
    }
    log(this.json, `Successfully uninstalled driver '${driver}'`.green);
    return true;
  }

  update (/*{driver}*/) {
    // TODO implementation
    return {};
  }
}

export {
  runDriverCommand
};