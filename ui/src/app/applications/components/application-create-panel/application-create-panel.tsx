/* eslint-disable no-prototype-builtins */
import {AutocompleteField, Checkbox, DataLoader, DropDownMenu, FormField, HelpIcon, Select} from 'argo-ui';
import * as deepMerge from 'deepmerge';
import * as React from 'react';
import {FieldApi, Form, FormApi, FormField as ReactFormField, Text} from 'react-form';
import {RevisionHelpIcon, YamlEditor} from '../../../shared/components';
import * as models from '../../../shared/models';
import {services} from '../../../shared/services';
import {ApplicationParameters} from '../application-parameters/application-parameters';
import {ApplicationRetryOptions} from '../application-retry-options/application-retry-options';
import {ApplicationSyncOptionsField} from '../application-sync-options/application-sync-options';
import {RevisionFormField} from '../revision-form-field/revision-form-field';
import {SetFinalizerOnApplication} from './set-finalizer-on-application';
import './application-create-panel.scss';
import {getAppDefaultSource} from '../utils';
import {debounce} from 'lodash-es';

const jsonMergePatch = require('json-merge-patch');

const appTypes = new Array<{field: string; type: models.AppSourceType}>(
    {type: 'Helm', field: 'helm'},
    {type: 'Kustomize', field: 'kustomize'},
    {type: 'Directory', field: 'directory'},
    {type: 'Plugin', field: 'plugin'}
);

const DEFAULT_APP: Partial<models.Application> = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: {
        name: ''
    },
    spec: {
        destination: {
            name: undefined,
            namespace: '',
            server: undefined
        },
        source: {
            path: '',
            repoURL: '',
            targetRevision: 'HEAD'
        },
        sources: [],
        project: ''
    }
};

const AutoSyncFormField = ReactFormField((props: {fieldApi: FieldApi; className: string}) => {
    const manual = 'Manual';
    const auto = 'Automatic';
    const {
        fieldApi: {getValue, setValue}
    } = props;
    const automated = getValue() as models.Automated;
    return (
        <React.Fragment>
            <label>Sync Policy</label>
            <Select
                value={automated ? auto : manual}
                options={[manual, auto]}
                onChange={opt => {
                    setValue(opt.value === auto ? {prune: false, selfHeal: false, enabled: true} : null);
                }}
            />
            {automated && (
                <div className='application-create-panel__sync-params'>
                    <div className='checkbox-container'>
                        <Checkbox onChange={val => setValue({...automated, enabled: val})} checked={automated.enabled === undefined ? true : automated.enabled} id='policyEnable' />
                        <label htmlFor='policyEnable'>Enable Auto-Sync</label>
                        <HelpIcon title='If checked, application will automatically sync when changes are detected' />
                    </div>
                    <div className='checkbox-container'>
                        <Checkbox onChange={val => setValue({...automated, prune: val})} checked={!!automated.prune} id='policyPrune' />
                        <label htmlFor='policyPrune'>Prune Resources</label>
                        <HelpIcon title='If checked, Argo will delete resources if they are no longer defined in Git' />
                    </div>
                    <div className='checkbox-container'>
                        <Checkbox onChange={val => setValue({...automated, selfHeal: val})} checked={!!automated.selfHeal} id='policySelfHeal' />
                        <label htmlFor='policySelfHeal'>Self Heal</label>
                        <HelpIcon title='If checked, Argo will force the state defined in Git into the cluster when a deviation in the cluster is detected' />
                    </div>
                </div>
            )}
        </React.Fragment>
    );
});

function normalizeAppSource(app: models.Application, type: string): boolean {
    const source = getAppDefaultSource(app);
    const repoType = source.repoURL.startsWith('oci://') ? 'oci' : (source.hasOwnProperty('chart') && 'helm') || 'git';
    if (repoType !== type) {
        if (type === 'git' || type === 'oci') {
            source.path = source.chart;
            delete source.chart;
            source.targetRevision = 'HEAD';
        } else {
            source.chart = source.path;
            delete source.path;
            source.targetRevision = '';
        }
        return true;
    }
    return false;
}

export const ApplicationCreatePanel = (props: {
    app: models.Application;
    onAppChanged: (app: models.Application) => any;
    createApp: (app: models.Application) => any;
    getFormApi: (api: FormApi) => any;
}) => {
    const [yamlMode, setYamlMode] = React.useState(false);
    const [explicitPathType, setExplicitPathType] = React.useState<{path: string; type: models.AppSourceType}>(null);
    const [retry, setRetry] = React.useState(false);
    const app = deepMerge(DEFAULT_APP, props.app || {});
    const debouncedOnAppChanged = debounce(props.onAppChanged, 800);
    const [destinationFieldChanges, setDestinationFieldChanges] = React.useState({destFormat: 'URL', destFormatChanged: null});
    const comboSwitchedFromPanel = React.useRef(false);
    const currentRepoType = React.useRef(undefined);
    const lastGitOrHelmUrl = React.useRef('');
    const lastOciUrl = React.useRef('');
    let destinationComboValue = destinationFieldChanges.destFormat;

    React.useEffect(() => {
        comboSwitchedFromPanel.current = false;
    }, []);

    React.useEffect(() => {
        return () => {
            debouncedOnAppChanged.cancel();
        };
    }, [debouncedOnAppChanged]);

    function normalizeTypeFields(formApi: FormApi, type: models.AppSourceType) {
        const appToNormalize = formApi.getFormState().values;
        for (const item of appTypes) {
            if (item.type !== type) {
                delete appToNormalize.spec.source[item.field];
            }
        }
        formApi.setAllValues(appToNormalize);
    }

    const currentName = app.spec.destination.name;
    const currentServer = app.spec.destination.server;
    if (destinationFieldChanges.destFormatChanged !== null) {
        if (destinationComboValue == 'NAME') {
            if (currentName === undefined && currentServer !== undefined && comboSwitchedFromPanel.current === false) {
                destinationComboValue = 'URL';
            } else {
                delete app.spec.destination.server;
                if (currentName === undefined) {
                    app.spec.destination.name = '';
                }
            }
        } else {
            if (currentServer === undefined && currentName !== undefined && comboSwitchedFromPanel.current === false) {
                destinationComboValue = 'NAME';
            } else {
                delete app.spec.destination.name;
                if (currentServer === undefined) {
                    app.spec.destination.server = '';
                }
            }
        }
    } else {
        if (currentName === undefined && currentServer === undefined) {
            destinationComboValue = destinationFieldChanges.destFormat;
            app.spec.destination.server = '';
        } else {
            if (currentName != undefined) {
                destinationComboValue = 'NAME';
            } else {
                destinationComboValue = 'URL';
            }
        }
    }

    const onCreateApp = (data: models.Application) => {
        if (destinationComboValue === 'URL') {
            delete data.spec.destination.name;
        } else {
            delete data.spec.destination.server;
        }

        props.createApp(data);
    };

    return (
        <DataLoader
            key='creation-deps'
            load={() =>
                Promise.all([
                    services.projects.list('items.metadata.name').then(projects => projects.map(proj => proj.metadata.name).sort()),
                    services.clusters.list().then(clusters => clusters.sort()),
                    services.repos.list()
                ]).then(([projects, clusters, reposInfo]) => ({projects, clusters, reposInfo}))
            }>
            {({projects, clusters, reposInfo}) => {
                const repos = reposInfo.map(info => info.repo).sort();
                const repoInfo = reposInfo.find(info => info.repo === app.spec.source.repoURL);
                if (repoInfo) {
                    normalizeAppSource(app, repoInfo.type || currentRepoType.current || 'git');
                }
                return (
                    <div className='application-create-panel'>
                        {(yamlMode && (
                            <YamlEditor
                                minHeight={800}
                                initialEditMode={true}
                                input={app}
                                onCancel={() => setYamlMode(false)}
                                onSave={async patch => {
                                    props.onAppChanged(jsonMergePatch.apply(app, JSON.parse(patch)));
                                    setYamlMode(false);
                                    return true;
                                }}
                            />
                        )) || (
                            <Form
                                validateError={(a: models.Application) => ({
                                    'metadata.name': !a.metadata.name && 'Application Name is required',
                                    'spec.project': !a.spec.project && 'Project Name is required',
                                    'spec.source.repoURL': !a.spec.source.repoURL && 'Repository URL is required',
                                    'spec.source.targetRevision': !a.spec.source.targetRevision && a.spec.source.hasOwnProperty('chart') && 'Version is required',
                                    'spec.source.path': !a.spec.source.path && !a.spec.source.chart && 'Path is required',
                                    'spec.source.chart': !a.spec.source.path && !a.spec.source.chart && 'Chart is required',
                                    // Verify cluster URL when there is no cluster name field or the name value is empty
                                    'spec.destination.server':
                                        !a.spec.destination.server && (!a.spec.destination.hasOwnProperty('name') || a.spec.destination.name === '') && 'Cluster URL is required',
                                    // Verify cluster name when there is no cluster URL field or the URL value is empty
                                    'spec.destination.name':
                                        !a.spec.destination.name && (!a.spec.destination.hasOwnProperty('server') || a.spec.destination.server === '') && 'Cluster name is required'
                                })}
                                defaultValues={app}
                                formDidUpdate={state => debouncedOnAppChanged(state.values as any)}
                                onSubmit={onCreateApp}
                                getApi={props.getFormApi}>
                                {api => {
                                    const generalPanel = () => (
                                        <div className='white-box'>
                                            <p>GENERAL</p>
                                            {/*
                                                    Need to specify "type='button'" because the default type 'submit'
                                                    will activate yaml mode whenever enter is pressed while in the panel.
                                                    This causes problems with some entry fields that require enter to be
                                                    pressed for the value to be accepted.

                                                    See https://github.com/argoproj/argo-cd/issues/4576
                                                */}
                                            {!yamlMode && (
                                                <button
                                                    type='button'
                                                    className='argo-button argo-button--base application-create-panel__yaml-button'
                                                    onClick={() => setYamlMode(true)}>
                                                    Edit as YAML
                                                </button>
                                            )}
                                            <div className='argo-form-row'>
                                                <FormField formApi={api} label='Application Name' qeId='application-create-field-app-name' field='metadata.name' component={Text} />
                                            </div>
                                            <div className='argo-form-row'>
                                                <FormField
                                                    formApi={api}
                                                    label='Project Name'
                                                    qeId='application-create-field-project'
                                                    field='spec.project'
                                                    component={AutocompleteField}
                                                    componentProps={{
                                                        items: projects,
                                                        filterSuggestions: true
                                                    }}
                                                />
                                            </div>
                                            <div className='argo-form-row'>
                                                <FormField
                                                    formApi={api}
                                                    field='spec.syncPolicy.automated'
                                                    qeId='application-create-field-sync-policy'
                                                    component={AutoSyncFormField}
                                                />
                                            </div>
                                            <div className='argo-form-row'>
                                                <FormField formApi={api} field='metadata.finalizers' component={SetFinalizerOnApplication} />
                                            </div>
                                            <div className='argo-form-row'>
                                                <label>Sync Options</label>
                                                <FormField formApi={api} field='spec.syncPolicy.syncOptions' component={ApplicationSyncOptionsField} />
                                                <ApplicationRetryOptions
                                                    formApi={api}
                                                    field='spec.syncPolicy.retry'
                                                    retry={retry || (api.getFormState().values.spec.syncPolicy && api.getFormState().values.spec.syncPolicy.retry)}
                                                    setRetry={setRetry}
                                                    initValues={api.getFormState().values.spec.syncPolicy ? api.getFormState().values.spec.syncPolicy.retry : null}
                                                />
                                            </div>
                                        </div>
                                    );

                                    const repoType = api.getFormState().values.spec.source.repoURL.startsWith('oci://')
                                        ? 'oci'
                                        : (api.getFormState().values.spec.source.hasOwnProperty('chart') && 'helm') || 'git';
                                    const sourcePanel = () => (
                                        <div className='white-box'>
                                            <p>SOURCE</p>
                                            <div className='row argo-form-row'>
                                                <div className='columns small-10'>
                                                    <FormField
                                                        formApi={api}
                                                        label='Repository URL'
                                                        qeId='application-create-field-repository-url'
                                                        field='spec.source.repoURL'
                                                        component={AutocompleteField}
                                                        componentProps={{
                                                            items: repos,
                                                            filterSuggestions: true
                                                        }}
                                                    />
                                                </div>
                                                <div className='columns small-2'>
                                                    <div style={{paddingTop: '1.5em'}}>
                                                        {(repoInfo && (
                                                            <React.Fragment>
                                                                <span>{(repoInfo.type || 'git').toUpperCase()}</span> <i className='fa fa-check' />
                                                            </React.Fragment>
                                                        )) || (
                                                            <DropDownMenu
                                                                anchor={() => (
                                                                    <p>
                                                                        {repoType.toUpperCase()} <i className='fa fa-caret-down' />
                                                                    </p>
                                                                )}
                                                                qeId='application-create-dropdown-source-repository'
                                                                items={['git', 'helm', 'oci'].map((type: 'git' | 'helm' | 'oci') => ({
                                                                    title: type.toUpperCase(),
                                                                    action: () => {
                                                                        if (repoType !== type) {
                                                                            const updatedApp = api.getFormState().values as models.Application;
                                                                            const source = getAppDefaultSource(updatedApp);
                                                                            // Save the previous URL value for later use
                                                                            if (repoType === 'git' || repoType === 'helm') {
                                                                                lastGitOrHelmUrl.current = source.repoURL;
                                                                            } else {
                                                                                lastOciUrl.current = source.repoURL;
                                                                            }
                                                                            currentRepoType.current = type;
                                                                            switch (type) {
                                                                                case 'git':
                                                                                case 'oci':
                                                                                    if (source.hasOwnProperty('chart')) {
                                                                                        source.path = source.chart;
                                                                                        delete source.chart;
                                                                                    }
                                                                                    source.targetRevision = 'HEAD';
                                                                                    source.repoURL =
                                                                                        type === 'git'
                                                                                            ? lastGitOrHelmUrl.current
                                                                                            : lastOciUrl.current === ''
                                                                                              ? 'oci://'
                                                                                              : lastOciUrl.current;
                                                                                    break;
                                                                                case 'helm':
                                                                                    if (source.hasOwnProperty('path')) {
                                                                                        source.chart = source.path;
                                                                                        delete source.path;
                                                                                    }
                                                                                    source.targetRevision = '';
                                                                                    source.repoURL = lastGitOrHelmUrl.current;
                                                                                    break;
                                                                            }
                                                                            api.setAllValues(updatedApp);
                                                                        }
                                                                    }
                                                                }))}
                                                            />
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                            {(repoType === 'oci' && (
                                                <React.Fragment>
                                                    <RevisionFormField formApi={api} helpIconTop={'2.5em'} repoURL={app.spec.source.repoURL} repoType={repoType} />
                                                    <div className='argo-form-row'>
                                                        <DataLoader
                                                            input={{repoURL: app.spec.source.repoURL, revision: app.spec.source.targetRevision}}
                                                            load={async src =>
                                                                src.repoURL &&
                                                                // TODO: for autocomplete we need to fetch paths that are used by other apps within the same project making use of the same OCI repo
                                                                new Array<string>()
                                                            }>
                                                            {(paths: string[]) => (
                                                                <FormField
                                                                    formApi={api}
                                                                    label='Path'
                                                                    qeId='application-create-field-path'
                                                                    field='spec.source.path'
                                                                    component={AutocompleteField}
                                                                    componentProps={{
                                                                        items: paths,
                                                                        filterSuggestions: true
                                                                    }}
                                                                />
                                                            )}
                                                        </DataLoader>
                                                    </div>
                                                </React.Fragment>
                                            )) ||
                                                (repoType === 'git' && (
                                                    <React.Fragment>
                                                        <RevisionFormField formApi={api} helpIconTop={'2.5em'} repoURL={app.spec.source.repoURL} repoType={repoType} />
                                                        <div className='argo-form-row'>
                                                            <DataLoader
                                                                input={{repoURL: app.spec.source.repoURL, revision: app.spec.source.targetRevision}}
                                                                load={async src =>
                                                                    (src.repoURL &&
                                                                        services.repos
                                                                            .apps(src.repoURL, src.revision, app.metadata.name, app.spec.project)
                                                                            .then(apps => Array.from(new Set(apps.map(item => item.path))).sort())
                                                                            .catch(() => new Array<string>())) ||
                                                                    new Array<string>()
                                                                }>
                                                                {(apps: string[]) => (
                                                                    <FormField
                                                                        formApi={api}
                                                                        label='Path'
                                                                        qeId='application-create-field-path'
                                                                        field='spec.source.path'
                                                                        component={AutocompleteField}
                                                                        componentProps={{
                                                                            items: apps,
                                                                            filterSuggestions: true
                                                                        }}
                                                                    />
                                                                )}
                                                            </DataLoader>
                                                        </div>
                                                    </React.Fragment>
                                                )) || (
                                                    <DataLoader
                                                        input={{repoURL: app.spec.source.repoURL}}
                                                        load={async src =>
                                                            (src.repoURL && services.repos.charts(src.repoURL).catch(() => new Array<models.HelmChart>())) ||
                                                            new Array<models.HelmChart>()
                                                        }>
                                                        {(charts: models.HelmChart[]) => {
                                                            const selectedChart = charts.find(chart => chart.name === api.getFormState().values.spec.source.chart);
                                                            return (
                                                                <div className='row argo-form-row'>
                                                                    <div className='columns small-10'>
                                                                        <FormField
                                                                            formApi={api}
                                                                            label='Chart'
                                                                            field='spec.source.chart'
                                                                            component={AutocompleteField}
                                                                            componentProps={{
                                                                                items: charts.map(chart => chart.name),
                                                                                filterSuggestions: true
                                                                            }}
                                                                        />
                                                                    </div>
                                                                    <div className='columns small-2'>
                                                                        <FormField
                                                                            formApi={api}
                                                                            field='spec.source.targetRevision'
                                                                            component={AutocompleteField}
                                                                            componentProps={{
                                                                                items: (selectedChart && selectedChart.versions) || [],
                                                                                filterSuggestions: true
                                                                            }}
                                                                        />
                                                                        <RevisionHelpIcon type='helm' />
                                                                    </div>
                                                                </div>
                                                            );
                                                        }}
                                                    </DataLoader>
                                                )}
                                        </div>
                                    );
                                    const destinationPanel = () => (
                                        <div className='white-box'>
                                            <p>DESTINATION</p>
                                            <div className='row argo-form-row'>
                                                {(destinationComboValue.toUpperCase() === 'URL' && (
                                                    <div className='columns small-10'>
                                                        <FormField
                                                            formApi={api}
                                                            label='Cluster URL'
                                                            qeId='application-create-field-cluster-url'
                                                            field='spec.destination.server'
                                                            componentProps={{
                                                                items: clusters.map(cluster => cluster.server),
                                                                filterSuggestions: true
                                                            }}
                                                            component={AutocompleteField}
                                                        />
                                                    </div>
                                                )) || (
                                                    <div className='columns small-10'>
                                                        <FormField
                                                            formApi={api}
                                                            label='Cluster Name'
                                                            qeId='application-create-field-cluster-name'
                                                            field='spec.destination.name'
                                                            componentProps={{
                                                                items: clusters.map(cluster => cluster.name),
                                                                filterSuggestions: true
                                                            }}
                                                            component={AutocompleteField}
                                                        />
                                                    </div>
                                                )}
                                                <div className='columns small-2'>
                                                    <div style={{paddingTop: '1.5em'}}>
                                                        <DropDownMenu
                                                            anchor={() => (
                                                                <p>
                                                                    {destinationComboValue} <i className='fa fa-caret-down' />
                                                                </p>
                                                            )}
                                                            qeId='application-create-dropdown-destination'
                                                            items={['URL', 'NAME'].map((type: 'URL' | 'NAME') => ({
                                                                title: type,
                                                                action: () => {
                                                                    if (destinationComboValue !== type) {
                                                                        destinationComboValue = type;
                                                                        comboSwitchedFromPanel.current = true;
                                                                        setDestinationFieldChanges({destFormat: type, destFormatChanged: 'changed'});
                                                                    }
                                                                }
                                                            }))}
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                            <div className='argo-form-row'>
                                                <FormField
                                                    qeId='application-create-field-namespace'
                                                    formApi={api}
                                                    label='Namespace'
                                                    field='spec.destination.namespace'
                                                    component={Text}
                                                />
                                            </div>
                                        </div>
                                    );

                                    const typePanel = () => (
                                        <DataLoader
                                            input={{
                                                repoURL: app.spec.source.repoURL,
                                                path: app.spec.source.path,
                                                chart: app.spec.source.chart,
                                                targetRevision: app.spec.source.targetRevision,
                                                appName: app.metadata.name
                                            }}
                                            load={async src => {
                                                if (src.repoURL && src.targetRevision && (src.path || src.chart)) {
                                                    return services.repos.appDetails(src, src.appName, app.spec.project, 0, 0).catch(() => ({
                                                        type: 'Directory',
                                                        details: {}
                                                    }));
                                                } else {
                                                    return {
                                                        type: 'Directory',
                                                        details: {}
                                                    };
                                                }
                                            }}>
                                            {(details: models.RepoAppDetails) => {
                                                const type = (explicitPathType && explicitPathType.path === app.spec.source.path && explicitPathType.type) || details.type;
                                                if (details.type !== type) {
                                                    switch (type) {
                                                        case 'Helm':
                                                            details = {
                                                                type,
                                                                path: details.path,
                                                                helm: {name: '', valueFiles: [], path: '', parameters: [], fileParameters: []}
                                                            };
                                                            break;
                                                        case 'Kustomize':
                                                            details = {type, path: details.path, kustomize: {path: ''}};
                                                            break;
                                                        case 'Plugin':
                                                            details = {type, path: details.path, plugin: {name: '', env: []}};
                                                            break;
                                                        // Directory
                                                        default:
                                                            details = {type, path: details.path, directory: {}};
                                                            break;
                                                    }
                                                }
                                                return (
                                                    <React.Fragment>
                                                        <DropDownMenu
                                                            anchor={() => (
                                                                <p>
                                                                    {type} <i className='fa fa-caret-down' />
                                                                </p>
                                                            )}
                                                            qeId='application-create-dropdown-source'
                                                            items={appTypes.map(item => ({
                                                                title: item.type,
                                                                action: () => {
                                                                    setExplicitPathType({type: item.type, path: app.spec.source.path});
                                                                    normalizeTypeFields(api, item.type);
                                                                }
                                                            }))}
                                                        />
                                                        <ApplicationParameters
                                                            noReadonlyMode={true}
                                                            application={app}
                                                            details={details}
                                                            save={async updatedApp => {
                                                                api.setAllValues(updatedApp);
                                                            }}
                                                        />
                                                    </React.Fragment>
                                                );
                                            }}
                                        </DataLoader>
                                    );

                                    return (
                                        <form onSubmit={api.submitForm} role='form' className='width-control'>
                                            {generalPanel()}

                                            {sourcePanel()}

                                            {destinationPanel()}

                                            {typePanel()}
                                        </form>
                                    );
                                }}
                            </Form>
                        )}
                    </div>
                );
            }}
        </DataLoader>
    );
};
