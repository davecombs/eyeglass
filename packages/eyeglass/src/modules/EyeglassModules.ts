import * as archy from "archy";
import * as fs from "fs";
import * as path from "path";
import * as semver from "semver";
import * as debug from "../util/debug";
import * as packageUtils from "../util/package";
import resolve from "../util/resolve";
import { SimpleCache } from "../util/SimpleCache";
import { URI } from "../util/URI";
import EyeglassModule, { ModuleSpecifier, DiscoverOptions } from "./EyeglassModule";
import merge = require("lodash.merge");
import { PackageJson } from "package-json";
import { IEyeglass } from "../IEyeglass";
import { SassImplementation } from "../util/SassImplementation";
import { Dict, isPresent } from "../util/typescriptUtils";

export const ROOT_NAME = ":root";

type ModuleCollection = Dict<Array<EyeglassModule>>;

type ModuleMap = Dict<EyeglassModule>;

type Dependencies = Exclude<PackageJson["dependencies"], undefined>;

const globalModuleCache = new SimpleCache<EyeglassModule>();
const globalModulePackageCache = new SimpleCache<string>();

interface DependencyVersionIssue {
  name: string;
  left: EyeglassModule;
  right: EyeglassModule;
}

interface ModuleBranch {
  name: string;
  version: string | undefined;
  path: string;
  dependencies: Dict<ModuleBranch> | undefined;
}
/**
  * Discovers all of the modules for a given directory
  *
  * @constructor
  * @param   {String} dir - the directory to discover modules in
  * @param   {Array} modules - the explicit modules to include
  * @param   {Boolean} useGlobalModuleCache - whether or not to use the global module cache
  */
export default class EyeglassModules {
  issues: {
    dependencies: {
      versions: Array<DependencyVersionIssue>;
      missing: Array<string>;
    };
    engine: {
      missing: Array<EyeglassModule>;
      incompatible: Array<EyeglassModule>;
    };
  };
  cache: {
    access: SimpleCache<boolean>;
    modules: SimpleCache<EyeglassModule | undefined>;
    modulePackage: SimpleCache<string | undefined>;
  };
  collection: ModuleMap;
  list: Array<EyeglassModule>;
  tree: ModuleBranch;
  projectName: string;
  eyeglass: EyeglassModule;
  constructor(dir: string, modules?: Array<ModuleSpecifier>, useGlobalModuleCache?: boolean) {
    this.issues = {
      dependencies: {
        versions: [],
        missing: []
      },
      engine: {
        missing: [],
        incompatible: []
      }
    };

    this.cache = {
      access: new SimpleCache(),
      modules: useGlobalModuleCache ? globalModuleCache : new SimpleCache<EyeglassModule>(),
      modulePackage: useGlobalModuleCache ? globalModulePackageCache : new SimpleCache<string>(),
    };

    // find the nearest package.json for the given directory
    dir = packageUtils.findNearestPackage(path.resolve(dir));

    // resolve the current location into a module tree
    let moduleTree = this.resolveModule(dir, true)!;

    // if any modules were passed in, add them to the module tree
    if (modules && modules.length) {
      moduleTree.dependencies = modules.reduce((dependencies, mod) => {
        let resolvedMod = new EyeglassModule(merge(mod, {
          isEyeglassModule: true
        }), this.discoverModules.bind(this));
        dependencies[resolvedMod.name] = resolvedMod;
        return dependencies;
      }, moduleTree.dependencies);
    }

    // convert the tree into a flat collection of deduped modules
    let collection = this.dedupeModules(flattenModules(moduleTree));

    // expose the collection
    this.collection = collection;
    // convert the collection object into a simple array for easy iteration
    this.list = Object.keys(collection).map((name) => collection[name]!);
    // prune and expose the tree
    this.tree = this.pruneModuleTree(moduleTree);
    // set the current projects name
    this.projectName = moduleTree.name;
    // expose a convenience reference to the eyeglass module itself
    this.eyeglass = this.find("eyeglass")!;

    // check for any issues we may have encountered
    this.checkForIssues();

    /* istanbul ignore next - don't test debug */
    debug.modules && debug.modules("discovered modules\n\t" + this.getGraph().replace(/\n/g, "\n\t"));
  }

  /**
    * initializes all of the modules with the given engines
    *
    * @param   {Eyeglass} eyeglass - the eyeglass instance
    * @param   {Function} sass - the sass engine
    */
  init(eyeglass: IEyeglass, sass: SassImplementation): void {
    this.list.forEach((mod) => mod.init(eyeglass, sass));
  }

  /**
    * Checks whether or not a given location has access to a given module
    *
    * @param   {String} name - the module name to find
    * @param   {String} origin - the location of the originating request
    * @returns {Object} the module reference if access is granted, null if access is prohibited
    */
  access(name: string, origin: string): EyeglassModule | null {
    let mod = this.find(name);

    // if we have a module, ensure that we can access it from the origin
    if (mod && !this.canAccessModule(name, origin)) {
      // if not, return null
      return null;
    }

    // otherwise, return the module reference
    return mod!;
  }

  /**
    * Finds a module reference by the module name
    *
    * @param   {String} name - the module name to find
    * @returns {Object} the module reference
    */
  find(name: string): EyeglassModule | undefined {
    return this.getFinalModule(name);
  }

  /**
    * Returns a formatted string of the module hierarchy
    *
    * @returns {String} the module hierarchy
    */
  getGraph(): string {
    let hierarchy = getHierarchy(this.tree);
    hierarchy.label = this.getDecoratedRootName();
    return archy(hierarchy);
  }
  /**
    * resolves the module and it's dependencies
    *
    * @param   {String} pkgPath - the path to the modules package.json location
    * @param   {Boolean} isRoot - whether or not it's the root of the project
    * @returns {Object} the resolved module definition
    */
  private resolveModule(pkgPath: string, isRoot: boolean = false): EyeglassModule | undefined {
    let cacheKey = `resolveModule~${pkgPath}!${!!isRoot}`;
    return this.cache.modules.getOrElse(cacheKey, () => {
      let pkg = packageUtils.getPackage(pkgPath);
      let isEyeglassMod = EyeglassModule.isEyeglassModule(pkg.data);
      // if the module is an eyeglass module OR it's the root project
      if (isEyeglassMod || (pkg.data && isRoot)) {
        // return a module reference
        return new EyeglassModule({
          isEyeglassModule: isEyeglassMod,
          path: path.dirname(pkg.path)
        }, this.discoverModules.bind(this), isRoot);
      } else {
        return;
      }
    });
  }

  /**
    * dedupes a collection of modules to a single version
    *
    * @this {EyeglassModules}
    *
    * @param   {Object} module - the collection of modules
    * @returns {Object} the deduped module collection
    */
  private dedupeModules(modules: ModuleCollection): ModuleMap {
    let deduped: ModuleMap = {};
    for (let name of Object.keys(modules)) {
      // first sort our modules by version
      let versions = modules[name]!.sort((a, b) => semver.rcompare(a.version || "0", b.version || "0"));
      // then take the highest version we found
      deduped[name] = versions.shift()!;
      // check for any version issues
      this.issues.dependencies.versions.push.apply(
        this.issues.dependencies.versions,
        getDependencyVersionIssues(versions, deduped[name]!)
      );
    }
    return deduped;
  }

  /**
    * checks for any issues in the modules we've discovered
    *
    * @this {EyeglassModules}
    *
    */
  private checkForIssues(): void {
    this.list.forEach((mod: EyeglassModule) => {
      // check engine compatibility
      if (!mod.eyeglass || !mod.eyeglass.needs) {
        // if `eyeglass.needs` is not present...
        // add the module to the missing engines list
        this.issues.engine.missing.push(mod);
      } else if (!semver.satisfies(this.eyeglass.version!, mod.eyeglass.needs)) {
        // if the current version of eyeglass does not satisfy the need...
        // add the module to the incompatible engines list
        this.issues.engine.incompatible.push(mod);
      }
    });
  }

  /**
    * rewrites the module tree to reflect the deduped modules
    *
    * @this {EyeglassModules}
    *
    * @param  {Object} moduleTree - the tree to prune
    * @returns {Object} the pruned tree
    */
  private pruneModuleTree(moduleTree: EyeglassModule): ModuleBranch {
    let finalModule = moduleTree.isEyeglassModule && this.find(moduleTree.name);
    // normalize the branch
    let branch: ModuleBranch = {
      name: finalModule && finalModule.name || moduleTree.name,
      version: (finalModule && finalModule.version || moduleTree.version),
      path: finalModule && finalModule.path || moduleTree.path,
      dependencies: undefined
    };
    // if the tree has dependencies
    let dependencies = moduleTree.dependencies;
    if (dependencies) {
      // copy them into the branch after recursively pruning
      branch.dependencies = {};
      for (let name of Object.keys(dependencies)) {
        branch.dependencies[name] = this.pruneModuleTree(dependencies[name]!);
      }
    }
    return branch;
  }

  /**
    * resolves the eyeglass module itself
    *
    * @returns {Object} the resolved eyeglass module definition
    */
  private getEyeglassSelf(): EyeglassModule {
    let eyeglassDir = path.resolve(__dirname, "..", "..");
    let eyeglassPkg = packageUtils.getPackage(eyeglassDir);

    let resolvedPkg = resolve(eyeglassPkg.path, eyeglassPkg.path, eyeglassDir);
    return this.resolveModule(resolvedPkg, false)!;
  }

  /**
    * discovers all the modules for a given set of options
    *
    * @param    {Object} options - the options to use
    * @returns  {Object} the discovered modules
    */
  private discoverModules(options: DiscoverOptions): Dict<EyeglassModule> | null {
    let pkg = options.pkg || packageUtils.getPackage(options.dir);

    let dependencies: Dependencies = {};

    // if there's package.json contents...
    /* istanbul ignore else - defensive conditional, don't care about else-case */
    if (pkg.data) {
      merge(
        dependencies,
        // always include the `dependencies` and `peerDependencies`
        pkg.data.dependencies,
        pkg.data.peerDependencies,
        // only include the `devDependencies` if isRoot
        options.isRoot && pkg.data.devDependencies
      );
    }

    // for each dependency...
    let dependentModules: Dict<EyeglassModule> = Object.keys(dependencies).reduce((modules: Dict<EyeglassModule>, dependency) => {
      // resolve the package.json
      let resolvedPkg = this.resolveModulePackage(
        packageUtils.getPackagePath(dependency),
        pkg.path,
        URI.system(options.dir)
      );
      if (!resolvedPkg) {
        // if it didn't resolve, they likely didn't `npm install` it correctly
        this.issues.dependencies.missing.push(dependency);
      } else {
        // otherwise, set it onto our collection
        let resolvedModule = this.resolveModule(resolvedPkg);
        if (resolvedModule) {
          modules[resolvedModule.name] = resolvedModule;
        }
      }
      return modules;
    }, {});

    // if it's the root...
    if (options.isRoot) {
      // ensure eyeglass itself is a direct dependency
      dependentModules["eyeglass"] = dependentModules["eyeglass"] || this.getEyeglassSelf();
    }

    return Object.keys(dependentModules).length ? dependentModules : null;
  }

  /**
    * resolves the package for a given module
    *
    * @see resolve()
    */
  private resolveModulePackage(id: string, parent: string, parentDir: string): string | undefined {
    let cacheKey = "resolveModulePackage~" + id + "!" + parent + "!" + parentDir;
    return this.cache.modulePackage.getOrElse(cacheKey, function () {
      try {
        return resolve(id, parent, parentDir);
      } catch (e) {
        /* istanbul ignore next - don't test debug */
        debug.modules && debug.modules(
          'failed to resolve module package %s',
          e
        )
        return;
      }
    });
  }

  /**
    * gets the final module from the collection
    *
    * @this {EyeglassModules}
    *
    * @param   {String} name - the module name to find
    * @returns {Object} the module reference
    */
  private getFinalModule(name: string): EyeglassModule | undefined {
    return this.collection[name];
  }

  /**
    * gets the root name and decorates it
    *
    * @this {EyeglassModules}
    *
    * @returns {String} the decorated name
    */
  private getDecoratedRootName(): string {
    return ROOT_NAME + ((this.projectName) ? "(" + this.projectName + ")" : "");
  }

  /**
    * whether or not a module can be accessed by the origin request
    *
    * @this {EyeglassModules}
    *
    * @param   {String} name - the module name to find
    * @param   {String} origin - the location of the originating request
    * @returns {Boolean} whether or not access is permitted
    */
  private canAccessModule(name: string, origin: string): boolean {
    // eyeglass can be imported by anyone, regardless of the dependency tree
    if (name === "eyeglass") {
      return true;
    }

    let canAccessFrom = (origin: string): boolean => {
      // find the nearest package for the origin
      let pkg = packageUtils.findNearestPackage(origin);
      let cacheKey = pkg + "!" + origin;
      return this.cache.access.getOrElse(cacheKey, () => {
        // find all the branches that match the origin
        let branches = findBranchesByPath({
          dependencies: this.tree
        }, pkg);

        let canAccess = branches.some(function(branch) {
          // if the reference is to itself (branch.name)
          // OR it's an immediate dependency (branch.dependencies[name])
          if (branch.name === name || branch.dependencies && branch.dependencies[name]) {
            return true;
          } else {
            return false;
          }
        });

        /* istanbul ignore next - don't test debug */
        debug.importer(
          "%s can%s be imported from %s",
          name,
          (canAccess ? "" : "not"),
          origin
        );
        return canAccess;
      });
    };

    // check if we can access from the origin...
    let canAccess = canAccessFrom(origin);

    // if not...
    if (!canAccess) {
      // check for a symlink...
      let realOrigin = fs.realpathSync(origin);
      /* istanbul ignore if */
      if (realOrigin !== origin) {
        /* istanbul ignore next */
        canAccess = canAccessFrom(realOrigin);
      }
    }

    return canAccess;
  }
}

/**
  * given a set of dependencies, gets the hierarchy nodes
  *
  * @param  {Object} dependencies - the dependencies
  * @returns {Object} the corresponding hierarchy nodes (for use in archy)
  */
function getHierarchyNodes(dependencies: ModuleBranch["dependencies"]): Array<archy.Data> | undefined {
  if (dependencies) {
    // for each dependency, recurse and get it's hierarchy
    return Object.keys(dependencies).map((name) => getHierarchy(dependencies[name]!));
  } else {
    return;
  }
}

/**
  * gets the archy hierarchy for a given branch
  *
  * @param  {Object} branch - the branch to traverse
  * @returns {Object} the corresponding archy hierarchy
  */
function getHierarchy(branch: ModuleBranch): archy.Data {
  // return an object the confirms to the archy expectations
  return {
    // if the branch has a version on it, append it to the label
    label: branch.name + (branch.version ? "@" + branch.version : ""),
    nodes: getHierarchyNodes(branch.dependencies)
  };
}

/**
  * find a branches in a tree with a given path
  *
  * @param  {Object} tree - the module tree to traverse
  * @param  {String} dir - the path to search for
  * @returns {Object} the branches of the tree that contain the path
  */
function findBranchesByPath(tree: Dict<ModuleBranch>, dir: string): Array<ModuleBranch> {
  // iterate over the tree
  return Object.keys(tree).reduce(function(branches, name: string) {
    let mod = tree[name]!;
    // if the module path matches the search path, push it onto our results
    if (mod.path === dir) {
      branches.push(mod);
    }
    // if the module has dependencies, search those as well
    if (mod.dependencies) {
      branches.push.apply(branches, findBranchesByPath(mod.dependencies, dir));
    }
    return branches;
  }, new Array<ModuleBranch>());
}

/**
  * given a branch of modules, flattens them into a collection
  *
  * @param   {Object} branch - the module branch
  * @param   {Object} collection - the incoming collection
  * @returns {Object} the resulting collection
  */
function flattenModules(branch: EyeglassModule, collection: ModuleCollection = {}): ModuleCollection {
  // if the branch itself is a module, add it...
  if (branch.isEyeglassModule) {
    collection[branch.name] = collection[branch.name] || [];
    collection[branch.name]!.push(branch);
  }

  let dependencies = branch.dependencies;

  if (dependencies) {
    for (let name of Object.keys(dependencies)) {
      flattenModules(dependencies[name]!, collection);
    }
  }

  return collection;
}

/**
  * given a set of versions, checks if there are any compat issues
  *
  * @param   {Array<Object>} modules - the various modules to check
  * @param   {String} finalModule - the final module to check against
  * @returns {Array<Object>} the array of any issues found
  */
function getDependencyVersionIssues(modules: Array<EyeglassModule>, finalModule: EyeglassModule): Array<DependencyVersionIssue> {
  return modules.map(function(mod) {
    // if the versions are not identical, log it
    if (mod.version !== finalModule.version) {
      /* istanbul ignore next - don't test debug */
      debug.modules && debug.modules(
        "asked for %s@%s but using %s",
        mod.name,
        mod.version,
        finalModule.version
      );
    }
    // check that the current module version is satisfied by the finalModule version
    // if not, push an error object onto the results
    if (!semver.satisfies(mod.version || "0", "^" + (finalModule.version || "0"))) {
      return {
        name: mod.name,
        left: mod,
        right: finalModule
      };
    } else {
      return;
    }
  }).filter<DependencyVersionIssue>(isPresent);
}

