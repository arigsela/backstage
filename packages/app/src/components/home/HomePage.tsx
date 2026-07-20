import {
  Content,
  Header,
  InfoCard,
  Link,
  Page,
} from '@backstage/core-components';
import {
  HomePageToolkit,
  HomePageStarredEntities,
  HomePageRecentlyVisited,
} from '@backstage/plugin-home';
import { HomePageSearchBar } from '@backstage/plugin-search';
import { SearchContextProvider } from '@backstage/plugin-search-react';
import { Grid, makeStyles } from '@material-ui/core';
import SyncIcon from '@material-ui/icons/Sync';
import BarChartIcon from '@material-ui/icons/BarChart';
import TimelineIcon from '@material-ui/icons/Timeline';
import LockIcon from '@material-ui/icons/Lock';
import MenuBookIcon from '@material-ui/icons/MenuBook';
import ExtensionIcon from '@material-ui/icons/Extension';
import AccountTreeIcon from '@material-ui/icons/AccountTree';

const useStyles = makeStyles(theme => ({
  searchBar: {
    display: 'flex',
    maxWidth: '60vw',
    boxShadow: theme.shadows[1],
    borderRadius: '50px',
    margin: 'auto',
  },
}));

// Quick-launch tiles: the tools opened daily + in-portal destinations.
const tools = [
  { url: 'https://argocd.arigsela.com', label: 'ArgoCD', icon: <SyncIcon /> },
  {
    url: 'https://grafana.arigsela.com',
    label: 'Grafana',
    icon: <BarChartIcon />,
  },
  {
    url: 'https://coroot.arigsela.com',
    label: 'coroot',
    icon: <TimelineIcon />,
  },
  { url: 'https://vault.arigsela.com', label: 'Vault', icon: <LockIcon /> },
  { url: '/docs', label: 'Docs', icon: <MenuBookIcon /> },
  { url: '/api-docs', label: 'API Explorer', icon: <ExtensionIcon /> },
  {
    // Seed the standalone graph with root entities — the page reads them as a
    // qs bracketed array (rootEntityRefs[]=...); without a root it renders empty.
    url: '/catalog-graph?rootEntityRefs[]=domain:default/platform&rootEntityRefs[]=domain:default/products',
    label: 'Catalog Graph',
    icon: <AccountTreeIcon />,
  },
];

export const HomePage = () => {
  const classes = useStyles();
  return (
    <Page themeId="home">
      <Header title="Homelab Platform" />
      <Content>
        <Grid container spacing={3}>
          <Grid item xs={12}>
            <SearchContextProvider>
              <HomePageSearchBar
                classes={{ root: classes.searchBar }}
                placeholder="Search the catalog, docs, and APIs…"
              />
            </SearchContextProvider>
          </Grid>
          <Grid item xs={12} md={6}>
            <HomePageToolkit title="Tools" tools={tools} />
          </Grid>
          <Grid item xs={12} md={6}>
            <InfoCard title="Welcome">
              Your homelab developer portal — search, browse the{' '}
              <Link to="/catalog">catalog</Link>, read the{' '}
              <Link to="/docs">docs</Link>, or{' '}
              <Link to="/create">create something new</Link>.
            </InfoCard>
          </Grid>
          <Grid item xs={12} md={6}>
            <HomePageStarredEntities />
          </Grid>
          <Grid item xs={12} md={6}>
            <HomePageRecentlyVisited />
          </Grid>
        </Grid>
      </Content>
    </Page>
  );
};
